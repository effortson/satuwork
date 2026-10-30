import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PREVIEW_WEB_KIND, extOf, previewKindOf } from '../src/chat/preview.ts'

test('extOf：只看最后一段，点开头的名字没有扩展名', () => {
  assert.equal(extOf('a/b/Report.PDF'), 'pdf')
  assert.equal(extOf('.env'), '')
  assert.equal(extOf('dir.v2/README'), '')
  assert.equal(extOf(undefined), '')
})

test('previewKindOf：按扩展名分，图片也认 content-type', () => {
  assert.equal(previewKindOf('x.png'), 'image')
  assert.equal(previewKindOf('blob', 'image/webp'), 'image')
  assert.equal(previewKindOf('a.pdf'), 'pdf')
  assert.equal(previewKindOf('a.markdown'), 'markdown')
  assert.equal(previewKindOf('a.htm'), 'html')
  assert.equal(previewKindOf('a.log'), 'text')
  assert.equal(previewKindOf('a.odt'), 'doc')
  assert.equal(previewKindOf('a.zip'), '')
  assert.equal(PREVIEW_WEB_KIND.xlsm, 'xlsx')
})
