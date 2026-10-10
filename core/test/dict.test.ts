import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dict } from '../src/i18n/dict.ts'

/**
 * 只验形状，不验译文内容：表里有几条是故意的「反例」——`中文: '中文'`（语言开关上那个
 * 词本来就不翻）、`台: ''` / `个: ''`（英文里没有量词，译成空串让 t() 把它吞掉）。
 */
test('译表：键非空、值都是字符串，条数没少', () => {
  const bad: string[] = []
  for (const [zh, en] of Object.entries(dict)) {
    if (!zh.trim()) bad.push(`空键 → ${JSON.stringify(en)}`)
    else if (typeof en !== 'string') bad.push(`${zh} 的值不是字符串：${JSON.stringify(en)}`)
  }
  assert.deepEqual(bad, [])
  assert.ok(Object.keys(dict).length > 1000, `译表只有 ${Object.keys(dict).length} 条，像是搬丢了`)
})
