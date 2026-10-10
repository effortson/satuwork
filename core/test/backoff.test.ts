import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHAT_ALIVE_MS, aliveLongEnough, chatRetryDelay, classifyStreamStatus, rosterRetryDelay } from '../src/chat/backoff.ts'

test('退避档位：对话流 500 起翻倍封顶 8 秒；名单流走表、到头停在 30 秒', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 39].map(chatRetryDelay), [500, 1000, 2000, 4000, 8000, 8000, 8000])
  assert.equal(rosterRetryDelay(0), 500)
  assert.equal(rosterRetryDelay(6), 30_000)
  assert.equal(rosterRetryDelay(99), 30_000)
})

test('活够 CHAT_ALIVE_MS 才算真连上', () => {
  assert.equal(aliveLongEnough(1000, 1000 + CHAT_ALIVE_MS - 1), false)
  assert.equal(aliveLongEnough(1000, 1000 + CHAT_ALIVE_MS), true)
})

test('状态码分治：401/403/404 认输，503/502/500 与没 body 的 200 退避，有 body 的 2xx 开', () => {
  assert.equal(classifyStreamStatus(401, true), 'dead')
  assert.equal(classifyStreamStatus(403, true), 'dead')
  assert.equal(classifyStreamStatus(404, true), 'dead')
  assert.equal(classifyStreamStatus(503, true), 'warming')
  assert.equal(classifyStreamStatus(502, true), 'warming')
  assert.equal(classifyStreamStatus(500, true), 'warming')
  assert.equal(classifyStreamStatus(200, false), 'warming')
  assert.equal(classifyStreamStatus(200, true), 'open')
})
