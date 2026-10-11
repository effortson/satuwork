import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEventStream, type StreamStatus } from '../src/chat/stream.ts'

function body(frames: string[]) {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f))
      c.close()
    },
  })
}

/** 每次 fetch 按顺序取一份脚本：{ status, frames? , text? } 或 'throw'。用完了就一直挂着（永不 resolve）。 */
function script(steps: any[]) {
  const urls: string[] = []
  let i = 0
  const fetch = async (url: string, init?: RequestInit) => {
    urls.push(url)
    const s = steps[i++]
    // 脚本用完了就一直挂着，但要认 abort：close() 之后 fetch 得像真的那样 reject，循环才收得了摊。
    if (s === undefined) return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    if (s === 'throw') throw new Error('net')
    return {
      status: s.status,
      ok: s.status >= 200 && s.status < 300,
      body: s.frames ? body(s.frames) : null,
      text: async () => s.text || '',
    } as unknown as Response
  }
  return { fetch, urls }
}

function run(steps: any[], cursorSeq: { v: number | null }) {
  const sc = script(steps)
  const events: any[] = []
  const statuses: StreamStatus[] = []
  const sleeps: number[] = []
  let clock = 0
  const h = runEventStream({
    fetch: sc.fetch,
    url: (after) => (after == null ? '/s?tail=1' : '/s?after=' + after),
    token: () => 'jwt',
    cursor: () => cursorSeq.v,
    onEvent: (ev) => {
      events.push(ev)
      if (typeof ev.seq === 'number') cursorSeq.v = ev.seq
    },
    onStatus: (s) => statuses.push(s),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
  })
  return { h, events, statuses, sleeps, urls: sc.urls, tick: (ms: number) => (clock += ms) }
}

test('事件经 onEvent 交出去，断了按游标续传；活够 10 秒档位归零', async () => {
  const cur = { v: null as number | null }
  const r = run(
    [
      { status: 200, frames: ['data: {"type":"runtime/hello","instanceId":"i1"}\n\ndata: {"seq":7,"type":"turn/start"}\n\n'] },
      { status: 200, frames: ['data: {"seq":8,"type":"turn/end"}\n\n'] },
    ],
    cur,
  )
  // 第一条流读完（流里没有时间推进，所以算「没活够」）→ 退避 500 → 第二条
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(r.events.map((e) => e.type), ['runtime/hello', 'turn/start', 'turn/end'])
  assert.deepEqual(r.urls.slice(0, 2), ['/s?tail=1', '/s?after=7'])
  assert.equal(r.sleeps[0], 500)
  assert.equal(r.sleeps[1], 1000, '没活够就沿档位继续退避')
  r.h.close()
  await r.h.done
  assert.equal(r.statuses[r.statuses.length - 1].kind, 'closed')
})

test('503 与连不上都退避；401 当场认输并带席位原话，不再重连', async () => {
  const cur = { v: 3 }
  const r = run(['throw', { status: 503 }, { status: 401, text: '票过期' }], cur)
  await r.h.done
  assert.deepEqual(
    r.statuses.map((s) => s.kind),
    ['warming', 'warming', 'dead'],
  )
  assert.deepEqual(r.sleeps, [500, 1000])
  const dead = r.statuses[2] as any
  assert.equal(dead.status, 401)
  assert.equal(dead.message, '票过期')
  assert.equal(r.urls.length, 3)
  assert.equal(r.urls[0], '/s?after=3')
})

test('退避到头转慢速长跑，不认输', async () => {
  const cur = { v: null as number | null }
  const steps = Array.from({ length: 42 }, () => ({ status: 503 }))
  const r = run(steps, cur)
  await new Promise((r) => setTimeout(r, 30))
  const idle = r.statuses.filter((s) => s.kind === 'idle')
  assert.ok(idle.length >= 1, '退避到头后该进 idle')
  assert.ok(r.sleeps.includes(30_000))
  r.h.close()
  await r.h.done
})
