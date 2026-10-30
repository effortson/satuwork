import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditItemIdOfPath, botIdOfPath, companyIdOfPath, connectorIdOfPath, machineIdOfPath, pluginIdOfPath, userIdOfPath } from '../src/paths.ts'

test('各种 /xxx/:id 只取第一段，并解码', () => {
  assert.equal(botIdOfPath('/bots/abc/memory'), 'abc')
  assert.equal(botIdOfPath('/bots/a%20b'), 'a b')
  assert.equal(botIdOfPath('/bots'), '')
  assert.equal(botIdOfPath('/x/bots/1'), '')
  assert.equal(connectorIdOfPath('/connectors/gmail'), 'gmail')
  assert.equal(pluginIdOfPath('/plugins/gmail'), 'gmail')
  assert.equal(pluginIdOfPath('/plugins'), '')
  assert.equal(companyIdOfPath('/companies/c1/billing'), 'c1')
  assert.equal(machineIdOfPath('/machines/m1'), 'm1')
  assert.equal(userIdOfPath('/users/u1'), 'u1')
})

test('审计总结：只认 /audit/summary/:id', () => {
  assert.equal(auditItemIdOfPath('/audit/summary/i1'), 'i1')
  assert.equal(auditItemIdOfPath('/audit/s1'), '')
})

test('不是字符串、空值一律回空串', () => {
  assert.equal(botIdOfPath(undefined), '')
  assert.equal(botIdOfPath(null), '')
  assert.equal(connectorIdOfPath(''), '')
})
