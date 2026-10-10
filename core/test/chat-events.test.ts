import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cursorOf, insertEvent, maxSeqOf, messageMentions, messageRefs, messageText, splitUploads } from '../src/chat/events.ts'

test('messageText：字符串、content 字符串、text/reasoning 块都认，别的块不算', () => {
  assert.equal(messageText('x'), 'x')
  assert.equal(messageText({ content: 'y' }), 'y')
  assert.equal(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image', path: 'p' }, { type: 'reasoning', text: 'b' }] }), 'ab')
  assert.equal(messageText(null), '')
})

test('messageMentions / messageRefs：只认带 label 的点名、认得出的两种引用', () => {
  // seq 故意给字符串：老日志里有这种，messageRefs 要 Number 过去。
  const msg: any = { content: [{ type: 'mention', kind: 'connector', id: 'gmail', label: 'Gmail' }, { type: 'mention', id: 'x' }, { type: 'ref', kind: 'file', path: 'a/b.xlsx' }, { type: 'ref', kind: 'message', seq: '4', role: 'user', excerpt: 'e', time: 5 }, { type: 'ref', kind: 'other' }] }
  assert.deepEqual(messageMentions(msg), [{ kind: 'connector', id: 'gmail', label: 'Gmail' }])
  assert.deepEqual(messageRefs(msg), [
    { kind: 'file', path: 'a/b.xlsx', name: 'b.xlsx' },
    { kind: 'message', seq: 4, role: 'user', excerpt: 'e', time: 5 },
  ])
})

test('splitUploads：只认我们自己拼的那段，中英两版；格式稍有不同就原样返回', () => {
  const r = splitUploads('我上传了文件，在工作区里：\n- `uploads/a.png`\n- `uploads/b c.pdf`\n帮我看看')
  assert.deepEqual(r, { text: '帮我看看', files: [{ path: 'uploads/a.png', name: 'a.png' }, { path: 'uploads/b c.pdf', name: 'b c.pdf' }] })
  assert.deepEqual(splitUploads('I uploaded some files. They are in the workspace at:\n- `uploads/x`\n'), { text: '', files: [{ path: 'uploads/x', name: 'x' }] })
  assert.deepEqual(splitUploads('我上传了文件，在工作区里：\n- not-a-path'), { text: '我上传了文件，在工作区里：\n- not-a-path', files: [] })
  assert.deepEqual(splitUploads(null), { text: '', files: [] })
})

test('insertEvent：按 seq 插入、去重，乱序到达也有序；没 seq 的追到末尾', () => {
  const list: any[] = []
  assert.equal(insertEvent(list, { seq: 41, type: 'a' }), true)
  assert.equal(insertEvent(list, { seq: 43, type: 'c' }), true)
  assert.equal(insertEvent(list, { seq: 42, type: 'b' }), true)
  assert.equal(insertEvent(list, { seq: 42, type: 'b-dup' }), false)
  assert.deepEqual(list.map((e) => e.seq), [41, 42, 43])
  assert.equal(insertEvent(list, { type: 'noseq' }), true)
  assert.equal(list.length, 4)
  // 就地改，不换数组
  const alias = list
  insertEvent(list, { seq: 40, type: 'z' })
  assert.equal(alias[0].seq, 40)
})

test('cursorOf / maxSeqOf：最后一个有 seq 的；空桶是 null / 0', () => {
  assert.equal(cursorOf([]), null)
  assert.equal(cursorOf([{ seq: 1, type: 'a' }, { type: 'b' }]), 1)
  assert.equal(maxSeqOf([{ seq: 3, type: 'a' }, { seq: 9, type: 'b' }, { seq: 5, type: 'c' }]), 9)
  assert.equal(maxSeqOf(null), 0)
})
