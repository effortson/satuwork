import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const domUtil = source('../ui/dom-util.js')
const linkScript = source('../../desktop/src-tauri/src/nav.rs').match(/const LINK_SCRIPT: &str = r#"([\s\S]*?)"#;/)[1]
  .replaceAll('__GATEWAY_URL__', '"https://gateway.example"')
  .replaceAll('__OPEN_PATH__', '"/__satuwork_open"')
  .replaceAll('__DEVICE__', '{"id":"test-device-0000001","name":"Test","platform":"darwin"}')

function nativeDownload(invoke) {
  const context = {
    window: { __TAURI_INTERNALS__: { invoke } },
    document: { addEventListener() {} },
    // 原生保存不应创建 blob URL 或触发浏览器下载。
    URL: { createObjectURL() { assert.fail('native download used a blob URL') } },
    Error,
  }
  runInNewContext(linkScript + '\n' + domUtil, context)
  return context
}

test('desktop save sends original binary bytes and an encoded Unicode filename', async () => {
  const bytes = Uint8Array.of(0, 255, 128, 13, 10)
  const name = '测试 + #1.md'
  let called = false
  const context = nativeDownload(async (command, body, options) => {
    called = true
    assert.equal(command, 'save_download')
    assert.deepEqual(new Uint8Array(body), bytes)
    assert.equal(decodeURIComponent(options.headers['x-satuwork-download-name']), name)
    return true
  })
  assert.equal(await context.saveBlob(new Blob([bytes]), name), true)
  assert.equal(called, true)
})

test('desktop cancellation resolves without falling back to a browser download', async () => {
  const context = nativeDownload(async () => false)
  assert.equal(await context.saveBlob(new Blob([]), 'empty.txt'), false)
})

test('native string errors become displayable errors without a browser fallback', async () => {
  const context = nativeDownload(async () => { throw '保存文件失败：Permission denied' })
  await assert.rejects(context.saveBlob(new Blob(['test']), 'test.md'), /Permission denied/)
})

test('browser download keeps the filename and delays revoking its blob URL', async () => {
  const events = []
  const blob = new Blob(['test'])
  const anchor = {
    click() { events.push(['click', this.href, this.download]) },
    remove() { events.push(['remove']) },
  }
  let cleanup
  const context = {
    window: {},
    document: {
      createElement(tag) { assert.equal(tag, 'a'); return anchor },
      body: { appendChild(node) { assert.equal(node, anchor); events.push(['append']) } },
    },
    URL: {
      createObjectURL(value) { assert.equal(value, blob); return 'blob:test' },
      revokeObjectURL(url) { events.push(['revoke', url]) },
    },
    setTimeout(fn, ms) { cleanup = fn; assert.equal(ms, 60_000) },
  }
  runInNewContext(domUtil, context)
  await context.saveBlob(blob, 'test.md', 60_000)
  assert.deepEqual(events, [['append'], ['click', 'blob:test', 'test.md'], ['remove']])
  cleanup()
  assert.deepEqual(events.at(-1), ['revoke', 'blob:test'])
})

test('workspace download awaits native saving and renders the actual failure', async () => {
  const context = nativeDownload(async () => { throw '保存文件失败：磁盘已满' })
  const flashes = []
  let rendered = false
  Object.assign(context, {
    state: { chatSessionId: 'session-1' },
    authHeaders: () => ({ authorization: 'Bearer test' }),
    swFetch: async (url, init) => {
      assert.equal(url, '/runtime/sessions/session-1/files?path=test.md&download=1')
      assert.equal(init.headers.authorization, 'Bearer test')
      return { ok: true, blob: async () => new Blob(['测试内容']) }
    },
    t: (text) => text,
    flash: (...args) => flashes.push(args),
    render: () => { rendered = true },
  })
  runInNewContext(source('../ui/core.js') + '\n' + source('../ui/chat-preview.js'), context)
  await context.downloadWorkspaceFile('test.md', 'test.md')
  assert.deepEqual(flashes, [['err', '下载失败：保存文件失败：磁盘已满']])
  assert.equal(rendered, true)
})
