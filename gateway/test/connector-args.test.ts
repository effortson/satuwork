import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dropEmptyFileArgs } from '../src/lib/connectors.ts'

test('drops an all-empty attachment handle the model filled in', () => {
  const args = { recipient_email: 'a@b.c', attachment: { name: '', s3key: '', mimetype: '' } }
  assert.deepEqual(dropEmptyFileArgs(args), { recipient_email: 'a@b.c' })
})

test('keeps a half-filled handle so the upstream error reaches the model', () => {
  const args = { attachment: { name: 'a.pdf', s3key: '', mimetype: 'application/pdf' } }
  assert.equal(dropEmptyFileArgs(args), args)
})

test('filters empty handles out of an attachment array', () => {
  const real = { name: 'a.pdf', s3key: 'k', mimetype: 'application/pdf' }
  assert.deepEqual(dropEmptyFileArgs({ attachments: [{ name: '', s3key: '', mimetype: '' }, real] }), { attachments: [real] })
  assert.deepEqual(dropEmptyFileArgs({ attachments: [{ name: '', s3key: '', mimetype: '' }] }), {})
})

test('leaves ordinary arguments untouched', () => {
  const args = { subject: '', body: 'hi', extra_recipients: [] }
  assert.equal(dropEmptyFileArgs(args), args)
  assert.equal(dropEmptyFileArgs(undefined), undefined)
})
