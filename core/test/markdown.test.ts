import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMarkdown } from '../src/markdown/render.ts'

/**
 * 只验「搬过来之后还是那一套」的几条关键路径。细到每种语法的断言在 e2e 的 markdown.mjs
 * （它经 gateway/ui/markdown.js 喂的也是这里的实现）。
 */
const md = createMarkdown()

test('基础块与行内：段落、标题、加粗贴全角逗号、原始 HTML 转义', () => {
  assert.equal(md.render('你好，世界'), '<p data-md="paragraph">你好，世界</p>')
  assert.ok(md.render('## 二级').includes('<h2 data-md="heading-2">二级</h2>'))
  assert.ok(md.render('**已完成**，接着说').includes('<strong data-md="strong">已完成</strong>，接着说'))
  assert.ok(!md.render('<script>alert(1)</script>').includes('<script>'))
  assert.equal(md.render('   '), '')
})

test('流式：半截围栏补收口；非流式不补', () => {
  const streamed = md.render('```js\nlet a', { streaming: true })
  assert.ok(streamed.includes('<figure class="sw-code"'), streamed)
  assert.ok(streamed.includes('let a'))
  const plain = md.render('落单的 * 星号')
  assert.ok(plain.includes('落单的 * 星号'))
})

test('splitBlocks：围栏和块级公式不被切开', () => {
  const blocks = md.splitBlocks('段一\n\n```js\nlet a\n\nlet b\n```\n\n段二')
  assert.equal(blocks.length, 3)
  assert.ok(blocks[1].includes('let a\n\nlet b'))
})

test('safeUrl：放行 https / mailto / 站内相对地址；拦 javascript: 与协议相对', () => {
  assert.equal(md.safeUrl('https://a/b'), 'https://a/b')
  assert.equal(md.safeUrl('mailto:x@y'), 'mailto:x@y')
  assert.equal(md.safeUrl('/files/a.png', 'img'), '/files/a.png')
  assert.equal(md.safeUrl('javascript:alert(1)'), '')
  assert.equal(md.safeUrl('//evil.com/x', 'img'), '')
  assert.equal(md.safeUrl('/\\evil.com', 'img'), '')
  assert.equal(md.safeUrl('data:image/png;base64,AAAA', 'img'), 'data:image/png;base64,AAAA')
  assert.equal(md.safeUrl('data:image/png;base64,AAAA', 'link'), '')
})

test('文案注入：代码块按钮的标签走 t；站外图片先画成按钮，点过加载的才画 img', () => {
  const en = createMarkdown({ t: (zh) => (zh === '复制' ? 'Copy' : zh) })
  const html = en.render('```\nx\n```')
  assert.ok(html.includes('title="Copy"'), html)
  assert.ok(html.includes('title="下载"'))
  const img = md.render('![a](https://x/y.png)')
  assert.ok(!img.includes('<img'), img)
  md.loadedImages.add('https://x/y.png')
  assert.ok(md.render('![a](https://x/y.png)').includes('<img'))
})

test('正文里的占位符字符 U+E000 被剔掉，不会撞到行内占位', () => {
  const out = md.render('a 0 `code` b')
  assert.ok(out.includes('<code'), out)
  assert.ok(!out.includes(''))
})
