import { test } from 'node:test'
import assert from 'node:assert/strict'
import { esc, tzDayStart, tzDayKey, fmtTime, dayStart, dayEnd, money, usd, fmtTokens } from '../src/format.ts'

test('esc：五个字符都转，null/undefined 当空串', () => {
  assert.equal(esc(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  assert.equal(esc(null), '')
  assert.equal(esc(undefined), '')
  assert.equal(esc(0), '0')
})

test('时区：Asia/Kuching 固定 +8，零点与日键互相对得上', () => {
  // 2026-10-10 00:00 +08:00 = 2026-10-09T16:00:00Z
  const start = tzDayStart('2026-10-10')
  assert.equal(start, Date.UTC(2026, 9, 9, 16, 0, 0))
  assert.equal(tzDayKey(start), '2026-10-10')
  assert.equal(tzDayKey(start - 1), '2026-10-09')
  assert.equal(tzDayStart('2026-10-10', 1), start + 24 * 3600 * 1000)
  assert.ok(Number.isNaN(tzDayStart('')))
  assert.ok(Number.isNaN(tzDayStart('2026-13')))
})

test('dayStart / dayEnd：空值回空串，坏日期也回空串', () => {
  assert.equal(dayStart(''), '')
  assert.equal(dayEnd(null), '')
  assert.equal(dayStart('not-a-date'), '')
  const s = dayStart('2026-01-01') as number
  const e = dayEnd('2026-01-01') as number
  assert.equal(e - s, 24 * 3600 * 1000 - 1)
})

test('fmtTime：按 SATU_TZ 显示，没值是一横', () => {
  assert.equal(fmtTime(0), '—')
  assert.equal(fmtTime(undefined), '—')
  // 2026-10-09T16:05:00Z → Kuching 2026/10/10 00:05
  const s = fmtTime(Date.UTC(2026, 9, 9, 16, 5))
  assert.match(s, /2026\/10\/10/)
  assert.match(s, /00:05/)
})

test('money：不足一美元三位小数，否则两位', () => {
  assert.equal(money(''), '—')
  assert.equal(money('abc'), '—')
  assert.equal(money(0.1234), '$0.123')
  assert.equal(money(12.345), '$12.35')
})

test('usd：入参是厘；带厘位才显示第三位；千分位按语言', () => {
  assert.equal(usd(0), '$0.00')
  assert.equal(usd(NaN), '—')
  assert.equal(usd(1990), '$1.99')
  assert.equal(usd(5), '$0.005')
  assert.equal(usd(-2500), '-$2.50')
  assert.equal(usd(1234567000, 'en'), '$1,234,567.00')
  assert.equal(usd(1234567000, 'zh'), '$1,234,567.00')
})

test('fmtTokens：K 与 M', () => {
  assert.equal(fmtTokens(0), '—')
  assert.equal(fmtTokens(999), '1K')
  assert.equal(fmtTokens(340000), '340K')
  assert.equal(fmtTokens(1200000), '1.2M')
  assert.equal(fmtTokens(2000000), '2M')
})
