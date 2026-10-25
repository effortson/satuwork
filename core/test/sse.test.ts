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

test('CRLF 被切在两块之间也归一', async () => {
  assert.deepEqual(await collect(readerOf(['data: {"a":1}\r', '\n\r\n'])), [{ a: 1 }])
})

test('hooks：每块一次 onChunk（ping 也算），onBatch 报这一块有没有 data 行；onChunk 回 false 就收摊', async () => {
  const seen: string[] = []
  const out: any[] = []
  const hooks = {
    onChunk: () => {
      seen.push('chunk')
    },
    onBatch: (sawData: boolean) => {
      seen.push(sawData ? 'data' : 'none')
    },
  }
  for await (const ev of sseEvents(readerOf([': ping\n\n', 'data: x\n\n', 'data: {"a":1}\n\ndata: {"b"', ':2}\n\n']), undefined, hooks)) {
    seen.push('ev')
    out.push(ev)
  }
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }])
  // 认不出 JSON 的 data 行也算「有 data」；半截的帧那一块不算。onBatch 在这一块的事件都交完之后。
  assert.deepEqual(seen, ['chunk', 'none', 'chunk', 'data', 'chunk', 'ev', 'data', 'chunk', 'ev', 'data'])
  let n = 0
  const cut = await (async () => {
    const got: any[] = []
    for await (const ev of sseEvents(readerOf(['data: {"a":1}\n\n', 'data: {"b":2}\n\n']), undefined, { onChunk: () => n++ < 1 })) got.push(ev)
    return got
  })()
  assert.deepEqual(cut, [{ a: 1 }])
})
