import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergePending } from '../src/chat/pending.ts'
import type { Folded } from '../src/protocol/events.ts'

const folded = (blocks: any[], status = ''): Folded => ({ blocks, status, statusAt: 0, todos: null, channelVia: false, modelSeq: 0 })

test('回执到了就销掉；只认 afterSeq 之后的，历史里同样的话不算', () => {
  const f = folded([{ kind: 'user', seq: 3, raw: '好的', text: '好的' }, { kind: 'user', seq: 9, raw: '好的', text: '好的' }])
  const p = { sessionId: 's', text: '好的', at: 1, afterSeq: 5 }
  const left = mergePending(f, [p])
  assert.deepEqual(left, [])
  assert.equal(f.blocks.length, 2)
  // 两条 pending 同文：第二条认不到回执，留下来画
  const f2 = folded([{ kind: 'user', seq: 9, raw: '好的', text: '好的' }])
  const left2 = mergePending(f2, [p, { ...p, at: 2 }])
  assert.equal(left2.length, 1)
  assert.equal(left2[0].at, 2)
})

test('没回执的画成 pending 块，附件段拆成药丸，状态置 sending、秒表从最早那条起', () => {
  const f = folded([], '')
  const left = mergePending(f, [
    { sessionId: 's', text: '我上传了文件，在工作区里：\n- `uploads/a.png`\n看看', at: 20, afterSeq: 1, images: [{ path: 'uploads/a.png', mime: 'image/png' }] },
    { sessionId: 's', text: '再来', at: 10, afterSeq: 1 },
  ])
  assert.equal(left.length, 2)
  const b: any = f.blocks[0]
  assert.equal(b.pending, true)
  assert.equal(b.text, '看看')
  assert.deepEqual(b.files, [{ path: 'uploads/a.png', name: 'a.png' }])
  assert.equal(b.raw.startsWith('我上传了文件'), true)
  assert.equal(f.status, 'sending')
  assert.equal(f.statusAt, 10)
  // 已经在跑就不改 status
  const g = folded([], 'running')
  mergePending(g, [{ sessionId: 's', text: 'x', at: 1, afterSeq: 0 }])
  assert.equal(g.status, 'running')
  assert.equal((g.blocks[0] as any).via, '')
})

test('渠道 Bot 上本地回显带 web 角标；空名单直接返回', () => {
  const f = folded([])
  f.channelVia = true
  mergePending(f, [{ sessionId: 's', text: 'x', at: 1, afterSeq: 0 }])
  assert.equal((f.blocks[0] as any).via, 'web')
  assert.deepEqual(mergePending(folded([]), []), [])
})
