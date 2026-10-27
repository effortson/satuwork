import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../../gateway/ui/desktop-window.js', import.meta.url), 'utf8')
const settle = () => new Promise(resolve => setImmediate(resolve))
function setup(invoke, platform = 'macos') {
  const handlers = new Map(), children = [], classes = new Set()
  const buttons = (platform === 'windows' ? ['minimize', 'zoom', 'close'] : ['close', 'minimize', 'fullscreen']).map(action => ({
    dataset: { windowAction: action }, disabled: false, attrs: {},
    setAttribute(key, value) { this.attrs[key] = value }, querySelector: () => ({ setAttribute() {} }),
  }))
  const group = { attrs: {}, setAttribute(key, value) { this.attrs[key] = value } }
  const document = {
    readyState: 'complete', hasFocus: () => true,
    documentElement: { lang: 'zh-CN', classList: { add: (...keys) => keys.forEach(key => classes.add(key)) } },
    body: { appendChild: el => children.push(el) },
    createElement: () => ({
      dataset: {}, attrs: {}, setAttribute(key, value) { this.attrs[key] = value },
      querySelector: key => key === '[role="group"]' ? group : buttons.find(b => key.includes(b.dataset.windowAction)),
      querySelectorAll: () => buttons,
      addEventListener: (type, fn) => handlers.set(`bar:${type}`, fn),
    }),
    addEventListener: (type, fn) => handlers.set(`document:${type}`, fn),
  }
  const window = { __SATUWORK_WINDOW_PLATFORM__: platform, __TAURI_INTERNALS__: invoke ? { invoke } : null, addEventListener: (type, fn) => handlers.set(`window:${type}`, fn) }
  runInNewContext(source, { window, document, MutationObserver: class { observe() {} } })
  const click = index => handlers.get('bar:click')({ target: { closest: () => buttons[index] } })
  const mouse = (interactive, detail = 1) => {
    let prevented = false
    handlers.get('document:mousedown')({ button: 0, detail, preventDefault() { prevented = true }, target: { closest: selector => selector.startsWith('button') ? interactive : true } })
    return prevented
  }
  return { children, classes, buttons, handlers, click, mouse, document }
}

test('browser pages do not mount native window controls', () => {
  const ui = setup()
  assert.equal(ui.children.length, 0)
  assert.equal(ui.classes.size, 0)
})

test('traffic lights target the invoking window and reflect fullscreen / fixed size', async () => {
  const calls = [], state = { focused: true, fullscreen: false, resizable: true }
  const ui = setup(async (command, args) => {
    calls.push({ command, args })
    if (command === 'desktop_window_action' && args.action === 'fullscreen') state.fullscreen = !state.fullscreen
    return { ...state }
  })
  await settle()
  assert.equal(ui.children.length, 2)
  assert(ui.classes.has('satu-custom-window'))
  ui.click(2); await settle()
  assert.equal(ui.buttons[2].attrs['aria-label'], '退出全屏')
  assert.equal(ui.buttons[2].attrs['aria-pressed'], 'true')
  ui.click(2); await settle()
  ui.click(1); await settle()
  ui.click(0); await settle()
  assert.deepEqual(calls.filter(c => c.args).map(c => c.args.action), ['fullscreen', 'fullscreen', 'minimize', 'close'])
  assert(calls.filter(c => c.args).every(c => Object.keys(c.args).join() === 'action'))
  state.resizable = false
  ui.handlers.get('window:resize')(); await settle()
  assert.equal(ui.buttons[2].disabled, true)
  const before = calls.length
  ui.click(2); await settle()
  assert.equal(calls.length, before)
  ui.document.documentElement.lang = 'en'
  ui.handlers.get('window:focus')(); await settle()
  assert.equal(ui.buttons[0].attrs['aria-label'], 'Close window')
})

test('blank chrome drags or zooms; interactive controls keep their clicks', async () => {
  const actions = []
  const ui = setup(async (_command, args) => {
    if (args) actions.push(args.action)
    return { focused: true, fullscreen: false, resizable: true }
  })
  assert.equal(ui.mouse(true), false)
  assert.equal(ui.mouse(false), true)
  await settle()
  assert.equal(ui.mouse(false, 2), true)
  await settle()
  assert.deepEqual(actions, ['drag', 'zoom'])
})

test('failed native action shows a retryable error without replacing the page', async () => {
  let finish, attempts = 0, fail = true
  const ui = setup(async (_command, args) => {
    if (args) {
      attempts++
      await new Promise(resolve => { finish = resolve })
      if (fail) throw new Error('temporarily unavailable')
    }
    return { focused: true, fullscreen: false, resizable: true }
  })
  ui.click(1); ui.click(1)
  assert.equal(attempts, 1)
  finish(); await settle()
  assert.equal(ui.children[1].hidden, false)
  assert.match(ui.children[1].textContent, /temporarily unavailable/)
  fail = false
  ui.click(1); finish(); await settle()
  assert.equal(attempts, 2)
  assert.equal(ui.children[1].hidden, true)
  assert.equal(ui.children.length, 2)
})


test('Windows controls follow minimize / maximize / close order and reflect restore state', async () => {
  const calls = [], state = { focused: true, fullscreen: false, maximized: false, resizable: true }
  const ui = setup(async (command, args) => {
    if (args) {
      calls.push(args.action)
      if (args.action === 'zoom') state.maximized = !state.maximized
    }
    return { ...state }
  }, 'windows')
  await settle()
  assert(ui.classes.has('satu-window-windows'))
  assert(!ui.classes.has('satu-window-macos'))
  assert.deepEqual(ui.buttons.map(b => b.dataset.windowAction), ['minimize', 'zoom', 'close'])
  assert.match(ui.children[0].innerHTML, /satu-window-glyph/)
  assert(!ui.children[0].innerHTML.includes('satu-window-dot'))
  assert.equal(ui.buttons[1].attrs['aria-label'], '最大化窗口')
  ui.click(1); await settle()
  assert.equal(ui.buttons[1].attrs['aria-label'], '还原窗口')
  assert.equal(ui.buttons[1].attrs['aria-pressed'], 'true')
  assert.equal(ui.children[0].dataset.maximized, 'true')
  ui.click(1); await settle()
  assert.equal(ui.buttons[1].attrs['aria-label'], '最大化窗口')
  ui.click(0); await settle()
  ui.click(2); await settle()
  assert.deepEqual(calls, ['zoom', 'zoom', 'minimize', 'close'])
  state.maximized = true
  ui.document.documentElement.lang = 'en'
  ui.handlers.get('window:resize')(); await settle()
  assert.equal(ui.buttons[1].attrs['aria-label'], 'Restore window')
})

test('Windows fixed-size and fullscreen windows cannot be maximized from the caption', async () => {
  let actions = 0
  const state = { focused: true, fullscreen: false, maximized: false, resizable: false }
  const ui = setup(async (_command, args) => {
    if (args) actions++
    return { ...state }
  }, 'windows')
  await settle()
  assert.equal(ui.buttons[1].disabled, true)
  assert.equal(ui.buttons[0].disabled, false)
  assert.equal(ui.buttons[2].disabled, false)
  ui.click(1); await settle()
  assert.equal(actions, 0)
  state.resizable = true; state.fullscreen = true
  ui.handlers.get('window:resize')(); await settle()
  assert.equal(ui.buttons[1].disabled, true)
  state.fullscreen = false
  ui.handlers.get('window:resize')(); await settle()
  assert.equal(ui.buttons[1].disabled, false)
})
