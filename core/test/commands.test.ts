import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cmdMatches, commandQueryAt, mentionQueryAt, parseCommand } from '../src/chat/commands.ts'

const CMDS = [{ name: 'compact' }, { name: 'new' }, { name: 'clear' }, { name: 'model' }]

test('mentionQueryAt：词首的 @ 才算，邮箱不算，打了空格就收', () => {
  assert.deepEqual(mentionQueryAt('请 @客户', 5), { at: 2, q: '客户' })
  assert.deepEqual(mentionQueryAt('@', 1), { at: 0, q: '' })
  assert.equal(mentionQueryAt('a@b.com', 7), null)
  assert.equal(mentionQueryAt('@Gmail 邮件', 9), null)
  assert.equal(mentionQueryAt('没有', 2), null)
})

test('commandQueryAt / cmdMatches：只认开头的 /名字', () => {
  assert.deepEqual(commandQueryAt('/Co', 3), { q: 'co' })
  assert.equal(commandQueryAt('/etc/hosts', 10), null)
  assert.equal(commandQueryAt('说 /compact', 10), null)
  assert.deepEqual(cmdMatches('c', CMDS).map((c) => c.name), ['compact', 'clear'])
  assert.equal(cmdMatches('', CMDS).length, 4)
})

test('parseCommand：命中、不认识、带参数、路径放行', () => {
  assert.deepEqual(parseCommand(' /Compact ', CMDS), { cmd: CMDS[0] })
  assert.deepEqual(parseCommand('/copmact', CMDS), { unknown: '/copmact' })
  assert.deepEqual(parseCommand('/model  2', CMDS), { cmd: CMDS[3], extra: true, arg: '2' })
  assert.equal(parseCommand('/etc/hosts', CMDS), null)
  assert.equal(parseCommand('你好', CMDS), null)
  assert.equal(parseCommand(null, CMDS), null)
})
