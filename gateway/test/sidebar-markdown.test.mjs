import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadApp } from '../../e2e/ui-dom.mjs'

const appPath = fileURLToPath(new URL('../ui/app.js', import.meta.url))

for (const [name, shell] of [['web', {}], ['desktop', { desktop: true }], ['mobile', { mobile: true }]]) {
  test(`${name}: 侧栏初次绘制和实时更新都显示 Markdown 摘要`, () => {
    const ui = loadApp({ appPath, base: 'http://localhost', ...shell })
    ui.state.runtimeBots = [{ id: 'b1', name: 'Bot' }]
    const send = (text, time) => ui.noteRosterFrame({
      type: 'roster/ev', botId: 'b1', replay: true,
      ev: { type: 'assistant/message', time, data: { text } },
    })

    send('**Subject: Re: Guardian Mala**\n见 [报告](https://example.com)', 100)
    assert.match(ui.chatRosterNav(), /class="satu-botsnip">Subject: Re: Guardian Mala 见 报告<\/span>/)

    // paintRoster 直接改 DOM，不经过首屏的 HTML 模板。
    const snip = { textContent: '', hidden: true }
    const row = {
      getAttribute: () => 'b1',
      querySelector: (selector) => selector === '.satu-botsnip' ? snip : null,
    }
    ui.document.querySelectorAll = (selector) => selector === '[data-bot-row]' ? [row] : []
    send('## **已完成**\n- 结果：`snake_case`', 200)
    ui.paintRoster()
    assert.equal(snip.textContent, '已完成 结果：snake_case')
    assert.equal(snip.hidden, false)

    send('---', 300)
    ui.paintRoster()
    assert.equal(snip.hidden, true)

    // 摘要仍走转义/textContent，消息里的 HTML 不能变成页面元素。
    send('**<img src=x onerror=alert(1)>**', 400)
    const html = ui.chatRosterNav()
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
    assert.ok(!html.includes('<img src=x'))
  })
}
