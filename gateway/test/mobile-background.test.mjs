import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const shell = readFileSync(new URL('../ui/shell.js', import.meta.url), 'utf8')
const feature = shell.slice(shell.indexOf('function pushBridge()'), shell.indexOf('async function syncMobilePush()'))
const resume = shell.slice(shell.indexOf("if (typeof document !== 'undefined')", shell.indexOf('async function takeMobilePushTap()')), shell.indexOf('/** boot() 里调一次'))

function setup({ mobile = true, bridge = true, status = { supported: true, backgroundRestricted: true, batteryOptimizationIgnored: false } } = {}) {
  let current = status, reads = 0, opens = 0, fail = false
  const slots = ['banner', 'profile'].map((kind) => ({ innerHTML: '', getAttribute: () => kind }))
  const listeners = {}
  const context = {
    window: {}, state: { me: { account: { role: 'member' } }, path: '/a/test' },
    mobileShell: () => mobile, t: (zh) => zh, esc: (s) => String(s).replaceAll('<', '&lt;'),
    document: { visibilityState: 'visible', querySelectorAll: () => slots, addEventListener: (type, fn) => { listeners[type] = fn } },
    takeMobilePushTap() {}, console: { warn() {} },
  }
  if (bridge) context.window.__SATUWORK_PUSH__ = {
    register() {},
    backgroundStatus: async () => { reads++; return current },
    openBackgroundSettings: async () => { opens++; if (fail) throw new Error('missing activity') },
  }
  runInNewContext(feature + '\n' + resume, context)
  return { context, slots, listeners, reads: () => reads, opens: () => opens,
    status: (next) => { current = next }, fail: () => { fail = true },
    dismiss: () => runInNewContext('mobileBackgroundDismissed = true; paintMobileBackground()', context) }
}

test('restricted and optimized modes prompt; unrestricted keeps only the preferences guide', async () => {
  const s = setup()
  await s.context.checkMobileBackground()
  assert.match(s.slots[0].innerHTML, /后台运行已受限制/)
  assert.match(s.slots[0].innerHTML, /mobile-background-settings/)
  s.status({ supported: true, backgroundRestricted: false, batteryOptimizationIgnored: false })
  await s.context.checkMobileBackground()
  assert.match(s.slots[0].innerHTML, /建议开启“不受限制”/)
  s.status({ supported: true, backgroundRestricted: false, batteryOptimizationIgnored: true })
  await s.context.checkMobileBackground()
  assert.equal(s.slots[0].innerHTML, '')
  assert.match(s.slots[1].innerHTML, /系统未报告后台限制/)
  assert.match(s.slots[1].innerHTML, /自启动、休眠应用/)
})

test('dismissal lasts until state changes, and settings remain available in preferences', async () => {
  const s = setup()
  await s.context.checkMobileBackground()
  s.dismiss()
  await s.context.checkMobileBackground()
  assert.equal(s.slots[0].innerHTML, '')
  assert.match(s.slots[1].innerHTML, /mobile-background-settings/)
  s.status({ supported: true, backgroundRestricted: false, batteryOptimizationIgnored: false })
  await s.context.checkMobileBackground()
  assert.match(s.slots[0].innerHTML, /不受限制/)
  s.context.state.path = '/profile'
  s.context.paintMobileBackground()
  assert.equal(s.slots[0].innerHTML, '')
})

test('returning from system settings rechecks and removes the warning', async () => {
  const s = setup()
  await s.context.checkMobileBackground()
  await s.context.openMobileBackgroundSettings()
  assert.equal(s.opens(), 1)
  s.status({ supported: true, backgroundRestricted: false, batteryOptimizationIgnored: true })
  s.listeners.visibilitychange()
  await s.context.checkMobileBackground()
  assert.equal(s.reads(), 2)
  assert.equal(s.slots[0].innerHTML, '')
  s.context.document.visibilityState = 'hidden'
  s.listeners.visibilitychange()
  assert.equal(s.reads(), 2)
})

test('failed settings launch offers a manual path', async () => {
  const s = setup()
  await s.context.checkMobileBackground()
  s.fail()
  await s.context.openMobileBackgroundSettings()
  assert.match(s.slots[0].innerHTML, /请手动进入：系统设置/)
})

test('web, desktop, older shells, iOS, signed-out users and owners have no warning', async () => {
  for (const options of [{ mobile: false }, { bridge: false }, { status: { supported: false } }]) {
    const s = setup(options)
    await s.context.checkMobileBackground()
    assert.equal(s.context.mobileBackgroundInner(), '')
    assert.equal(s.context.mobileBackgroundInner(true), '')
  }
  const s = setup()
  delete s.context.window.__SATUWORK_PUSH__.backgroundStatus
  await s.context.checkMobileBackground()
  assert.equal(s.reads(), 0)
  for (const me of [null, { account: { role: 'owner' } }]) {
    const s = setup()
    s.context.state.me = me
    await s.context.checkMobileBackground()
    assert.equal(s.reads(), 0)
  }
})
