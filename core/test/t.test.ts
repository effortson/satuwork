import { test } from 'node:test'
import assert from 'node:assert/strict'
import { errText, t } from '../src/i18n/t.ts'

test('t：中文直接回；英文先看就地译文、再查表、查不到原样', () => {
  assert.equal(t('zh', '保存', 'Save'), '保存')
  assert.equal(t('en', '保存', 'Save'), 'Save')
  assert.equal(t('en', '保存'), 'Save')
  assert.equal(t('en', '这句肯定不在表里'), '这句肯定不在表里')
})

test('t：键两边的排版空格剥掉再查，查到再贴回去', () => {
  assert.equal(t('en', ' 保存 '), ' Save ')
})

test('errText：中文原样；英文整句查表，带数字的按模式翻', () => {
  assert.equal(errText('zh', '口令至少 10 位'), '口令至少 10 位')
  assert.equal(errText('en', '口令至少 10 位'), 'Password must be at least 10 characters')
  assert.equal(errText('en', '尝试次数太多，请 3 分钟后再试'), 'Too many attempts — try again in 3 minutes.')
  assert.equal(errText('en', '还有 2 张转人工的单子没结，先处理掉、或等它交回来再清空'), '2 human handoff(s) are still open — resolve them or wait for them to come back before clearing.')
  assert.equal(errText('en', ''), '')
  assert.equal(errText('en', null), null)
  assert.equal(errText('en', '表里没有这句'), '表里没有这句')
})
