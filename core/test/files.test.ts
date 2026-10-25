import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileCands, fileEdgeOk, fileHits, knownFiles } from '../src/chat/files.ts'

test('knownFiles：附件、引用的文件、工具的产出和看过的都算，按路径去重', () => {
  const known = knownFiles([
    { files: [{ path: 'a/报表.xlsx' }], refs: [{ kind: 'file', path: 'b.md', name: 'B' }, { kind: 'url', path: 'x' }] },
    { tools: [{ files: [{ path: 'a/报表.xlsx', name: '别名' }], refs: [{ path: 'src/a.ts' }] }] },
  ])
  assert.deepEqual([...known.values()], [
    { path: 'a/报表.xlsx', name: '报表.xlsx' },
    { path: 'b.md', name: 'B' },
    { path: 'src/a.ts', name: 'a.ts' },
  ])
})

test('fileCands：完整路径和不重名、带扩展名的文件名，长的在前', () => {
  const known = knownFiles([{ files: [{ path: 'x/index.ts' }, { path: 'y/index.ts' }, { path: 'docs/报告.pdf' }, { path: '报告' }] }])
  assert.deepEqual(fileCands(known).map((c) => c.needle), ['docs/报告.pdf', 'x/index.ts', 'y/index.ts', '报告.pdf'])
})

test('fileHits：完整路径赢过文件名，边界不对的不认，中文挨着也认', () => {
  const cands = fileCands(knownFiles([{ files: [{ path: 'src/a.ts' }, { path: 'out/报表.xlsx' }] }]))
  const hits = fileHits('看 src/a.ts，已生成报表.xlsx，不是报表.xlsx.bak', cands)
  assert.deepEqual(hits.map((h) => [h.start, h.end, h.file.path]), [[2, 10, 'src/a.ts'], [14, 21, 'out/报表.xlsx']])
  assert.deepEqual(fileHits('', cands), [])
  assert.equal(fileEdgeOk('xa.ts', 1, 5), false)
  assert.equal(fileEdgeOk('(a.ts)', 1, 5), true)
})
