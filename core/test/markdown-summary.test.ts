import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markdownSummary } from '../src/markdown/summary.ts'

test('摘要移除标题、强调、引用、列表和任务框，合并成一行', () => {
  assert.equal(markdownSummary('## **Subject: Re: Guardian Mala**\n\n> **已完成**，*重点*和~~旧版~~\n- [x] 第一项\n1. 第二项'),
    'Subject: Re: Guardian Mala 已完成，重点和旧版 第一项 第二项')
  assert.equal(markdownSummary('***重点***，__加粗__与 _斜体_\n标题\n===\n- - -'), '重点，加粗与 斜体 标题')
})

test('链接和图片保留标题，引用链接的定义不占摘要', () => {
  assert.equal(markdownSummary('见 [**文档**](https://example.com/a_(b) "说明") 和 ![截图](https://example.com/a.png)'), '见 文档 和 截图')
  assert.equal(markdownSummary('[文档][docs] [docs][] [docs]\n\n[docs]: https://example.com'), '文档 docs docs')
  assert.equal(markdownSummary('<https://example.com/a_b_c>'), 'https://example.com/a_b_c')
})

test('代码、转义字符、变量名、金额和裸 URL 保留字面内容', () => {
  assert.equal(markdownSummary('`**literal** | snake_case`\n```js\nconst x = "**keep**";\n```'), '**literal** | snake_case const x = "**keep**";')
  assert.equal(markdownSummary('~~~txt\n# **未闭合的代码**'), '# **未闭合的代码**')
  assert.equal(markdownSummary('\\*原样\\* snake_case_name $100 到 $200 https://example.com/a_b_c'), '*原样* snake_case_name $100 到 $200 https://example.com/a_b_c')
  assert.equal(markdownSummary('正文\uE0000\uE000 `安全`'), '正文0 安全')
})

test('表格保留单元格内容，纯格式摘要为空', () => {
  assert.equal(markdownSummary('| 名称 | 状态 |\n| --- | :---: |\n| **任务** | 完成 |'), '名称 状态 任务 完成')
  assert.equal(markdownSummary(' \n---\n***\n___\n'), '')
})

test('去格式之后才截断，长链接地址不挤掉正文；HTML 保留为字面文本', () => {
  const body = '正文'.repeat(80)
  assert.equal(markdownSummary(`**[文档](https://example.com/${'a'.repeat(200)})** ${body}`), `文档 ${body}`.slice(0, 120))
  assert.equal(markdownSummary('<img src=x onerror=alert(1)> &amp;'), '<img src=x onerror=alert(1)> &amp;')
  const incomplete = `[文档](https://example.com/${'a'.repeat(2000)}`
  assert.equal(markdownSummary(incomplete), incomplete.slice(0, 120))
})
