import assert from 'node:assert/strict'
import { test } from 'node:test'
import { annotateFileParams, dropEmptyFileArgs } from '../src/lib/connectors.ts'

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

const FILE = {
  type: 'object',
  required: ['name', 'mimetype', 's3key'],
  properties: { name: { type: 'string' }, mimetype: { type: 'string' }, s3key: { type: 'string' } },
  file_uploadable: true,
}

test('hints a single-or-list file param (anyOf) once, on the outer level', () => {
  const schema = {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      attachment: { anyOf: [FILE, { type: 'array', items: FILE }], description: 'File(s) to attach.' },
    },
  }
  const out = annotateFileParams(schema) as { properties: Record<string, { description?: string; anyOf?: unknown[] }> }
  const att = out.properties.attachment
  assert.match(att.description ?? '', /^File\(s\) to attach\.\n【文件参数】/)
  assert.match(att.description ?? '', /放进一个数组/)
  assert.deepEqual(att.anyOf, [FILE, { type: 'array', items: FILE }])
  assert.equal(out.properties.subject, schema.properties.subject)
})

test('leaves an anyOf without any file branch alone', () => {
  const schema = { type: 'object', properties: { when: { anyOf: [{ type: 'string' }, { type: 'integer' }] } } }
  assert.equal(annotateFileParams(schema), schema)
})
