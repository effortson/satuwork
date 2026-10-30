import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notificationExcerpt, notificationPreview } from '../src/chat/notification.ts'

test('通知摘要是纯文本，去掉 Markdown、标签和控制字符', () => {
  assert.equal(notificationPreview('## 发票整理完成\n\n- 已核对 **3 张**发票\n- 查看 [报表](https://example.com/report)\n<b>合计</b> RM 1,250\u0000'),
    '发票整理完成 已核对 3 张发票 查看 报表 合计 RM 1,250')
  assert.equal(notificationPreview('`*原样*`'), '*原样*')
  assert.equal(notificationPreview('报表：<https://example.com/report>'), '报表：https://example.com/report')
  assert.equal(notificationPreview(undefined), '')
  assert.equal(notificationPreview({ text: '不能当正文' }), '')
})

test('通知摘要最多 240 个 Unicode 字符，截断后带省略号', () => {
  for (const text of ['内容'.repeat(200), '😀'.repeat(300)]) {
    const preview = notificationPreview(text)
    assert.equal(Array.from(preview).length, 240)
    assert.ok(preview.endsWith('…'))
    assert.equal(preview.includes('\uFFFD'), false)
  }
  assert.equal(notificationExcerpt('  最后一条回复  '), '最后一条回复')
})
