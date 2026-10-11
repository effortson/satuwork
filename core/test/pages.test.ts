import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeChatPage } from '../src/chat/pages.ts'

test('谁知道得更早谁说了算；hasMore 跟着 firstSeq 走；loading 只有明传才改', () => {
  let p = mergeChatPage(undefined, { firstSeq: 100, hasMore: true })
  assert.deepEqual(p, { firstSeq: 100, hasMore: true, loading: false })
  // 窄窗口晚到：不覆盖
  p = mergeChatPage(p, { firstSeq: 120, hasMore: false })
  assert.equal(p.firstSeq, 100)
  assert.equal(p.hasMore, true)
  // 更早的赢
  p = mergeChatPage(p, { firstSeq: 40, hasMore: false })
  assert.equal(p.firstSeq, 40)
  assert.equal(p.hasMore, false)
  // 没带游标：已经知道的不动
  p = mergeChatPage(p, { hasMore: true })
  assert.equal(p.hasMore, false)
  // 没带游标、本来也不知道：认它那句
  assert.equal(mergeChatPage(undefined, { hasMore: true }).hasMore, true)
  p = mergeChatPage(p, { loading: true })
  assert.equal(p.loading, true)
  p = mergeChatPage(p, { firstSeq: 30 })
  assert.equal(p.loading, true)
})
