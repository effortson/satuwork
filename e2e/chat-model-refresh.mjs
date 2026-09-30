/**
 * 对话框里那个日常模型选择器，名单要跟得上平台（gateway/ui/chat.js 的 chatModelSnap）。
 *
 * 平台改了日常模型 / 备选，席位一分钟内就重拉了目录，但它不会往会话里发 `session/model`
 * 事件——那份名单不是这条会话的事。界面以前只在那种事件或取失败时才重取，于是网页刷新一下
 * 就好，桌面端的窗口一开几天，选择器一直挂着打开时那份。这里钉两件事：
 *
 *   1. 点开选择器当场重取，挑的那一刻看到的是席位眼下的名单；关上不发请求。
 *   2. 一份好快照过了 CHAT_MODEL_TTL_MS 自己重取；没过期不重取；重取失败不把手上那份扔掉。
 *
 * 不起 Gateway：/runtime/sessions/<id>/model 由 fetchImpl 接管。
 */
import { join } from 'node:path'
import { el, loadApp } from './ui-dom.mjs'

const option = (key, label, isDefault = false) => ({ key, label, isDefault })

function modelSeat() {
  const seat = {
    calls: 0,
    fail: false,
    options: [option('a/1', 'Model A', true), option('b/2', 'Model B')],
  }
  seat.fetchImpl = async (path) => {
    if (!String(path).includes('/model')) return { ok: true, status: 200, text: async () => '{}' }
    seat.calls += 1
    if (seat.fail) return { ok: false, status: 502, text: async () => JSON.stringify({ error: '席位没响应' }) }
    const body = { options: seat.options, effective: seat.options[0], picked: null }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  return seat
}

/**
 * 选择器那颗药丸。真页面里它在 `.sw-model` 里面——少了这个祖先，app.js 顶上「点到选择器
 * 外面就收起」那条会先把它收了，于是「关上」那一下又被当成「点开」。
 */
function chip() {
  const b = el('button', { 'data-act': 'chat-model' })
  const closest = b.closest.bind(b)
  b.closest = (sel) => (sel === '.sw-model' ? b : closest(sel))
  return b
}

/** openChatModel 里那次重取是 `void` 出去的，让它跑完。 */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

export async function runChatModelRefresh({ root, test, assert, log }) {
  const appPath = join(root, 'gateway/ui/app.js')
  const base = 'http://127.0.0.1:9'
  const stubIds = ['chat-model', 'chat-model-chip', 'chat-model-pop']
  const open = (seat) => {
    const ui = loadApp({ appPath, base, token: 'jwt', fetchImpl: seat.fetchImpl, stubIds })
    ui.state.chatSessionId = 's-1'
    ui.state.chatEvents = []
    return ui
  }
  log('\n# chat-model-refresh')

  await test('点开选择器当场重取：平台加的备选立刻出现；关上不发请求', async () => {
    const seat = modelSeat()
    const ui = open(seat)
    await ui.syncChatModel('s-1', false)
    assert(seat.calls === 1, `先取一次：${seat.calls}`)

    // 平台那边加了一个备选。席位已经跟上，但不会往这条会话发事件。
    seat.options = [...seat.options, option('c/3', 'Model C')]
    await ui.fire('click', chip())
    await settle()
    assert(seat.calls === 2, `点开时该当场重取：${seat.calls}`)
    const pop = ui.stubs.get('chat-model-pop').innerHTML
    assert(pop.includes('Model C'), `重取回来的名单没画进浮层：${pop}`)

    await ui.fire('click', chip())
    await settle()
    assert(seat.calls === 2, `关上不该再发请求：${seat.calls}`)
  })

  await test('快照过期自己重取；没过期不取；重取失败留着旧的', async () => {
    const seat = modelSeat()
    const ui = open(seat)
    await ui.syncChatModel('s-1', false)
    ui.paintChatModel({ modelSeq: 0 })
    await settle()
    assert(seat.calls === 1, `没过期不该重取：${seat.calls}`)

    // 平台把默认换成了 B。
    seat.options = [option('b/2', 'Model B', true), option('d/4', 'Model D')]
    ui.chatModelSnap.get('s-1').at = Date.now() - ui.CHAT_MODEL_TTL_MS - 1
    ui.paintChatModel({ modelSeq: 0 })
    await settle()
    assert(seat.calls === 2, `过期了该重取：${seat.calls}`)
    const chip = ui.stubs.get('chat-model-chip').textContent
    assert(chip.startsWith('Model B'), `选择器上该换成平台新的默认：${chip}`)

    // 再过期一次，这回席位没响应：选择器不能消失，名字留着上一份。
    seat.fail = true
    ui.chatModelSnap.get('s-1').at = Date.now() - ui.CHAT_MODEL_TTL_MS - 1
    ui.paintChatModel({ modelSeq: 0 })
    await settle()
    assert(seat.calls === 3, `过期了该重取：${seat.calls}`)
    assert(ui.stubs.get('chat-model').hidden === false, '重取失败时选择器不该消失')
    assert(ui.stubs.get('chat-model-chip').textContent.startsWith('Model B'), '重取失败时该留着上一份')
  })
}
