/**
 * 桌面壳自己的升级在界面这一侧的样子（gateway/ui/shell.js 的 desktopUpdate*）。
 *
 * 壳子那头（desktop/src-tauri/src/self_update.rs）在 node 里跑不起来，这里用一座假桥
 * 顶上 `window.__SATUWORK_DESKTOP_UPDATE__`，钉的是界面对它几种状态的反应：
 *
 *   1. 浏览器里没有这座桥：一个槽都不画，个人设置里也不出现「检查更新」。
 *   2. 查到新版：侧栏和登录页都亮一条可以点的「有新版本」。
 *   3. 点了：调 install，然后轮询 status 画进度；壳子报失败时回到可点状态、说明原因。
 *   4. 已是最新：侧栏什么都没有，个人设置里说「已是最新版本」。
 *
 * 不起 Gateway：base 指一个不存在的地址，这几条一个请求都不发。也不调 boot()——
 * 它会挂上六小时一次的定时器，让测试进程退不出去。
 */
import { join } from 'node:path'
import { el, loadApp } from './ui-dom.mjs'

const AVAILABLE = { phase: 'available', current: '0.1.1', version: '0.1.2', notes: null, downloaded: 0, total: null, error: null }

function fakeBridge(steps) {
  const calls = []
  let statusAt = 0
  return {
    calls,
    bridge: {
      check: async (force) => {
        calls.push(['check', force])
        return steps.check
      },
      install: async () => {
        calls.push(['install'])
        return steps.install
      },
      status: async () => {
        calls.push(['status'])
        const view = steps.status[Math.min(statusAt, steps.status.length - 1)]
        statusAt += 1
        return view
      },
    },
  }
}

export async function runDesktopUpdate({ root, test, assert, log }) {
  const appPath = join(root, 'gateway/ui/app.js')
  const base = 'http://127.0.0.1:9'
  log('\n# desktop-update')

  await test('浏览器里没有升级桥：侧栏、登录页、个人设置都不出现升级的东西', async () => {
    const ui = loadApp({ appPath, base })
    assert(ui.desktopUpdateSlot('side') === '', '浏览器里侧栏不该有升级槽')
    assert(!ui.loginView().includes('data-desktop-update'), '浏览器里登录页不该有升级槽')
    assert((await ui.checkDesktopUpdate(true)) === null, '没有桥时 check 该什么都不做')
  })

  await test('查到新版：侧栏与登录页亮一条能点的「有新版本」', async () => {
    const { bridge, calls } = fakeBridge({ check: AVAILABLE })
    const ui = loadApp({ appPath, base, desktop: true, desktopUpdateBridge: bridge })
    await ui.checkDesktopUpdate(false)
    assert(calls[0][0] === 'check' && calls[0][1] === false, `该先问一次：${JSON.stringify(calls)}`)
    const side = ui.desktopUpdateSlot('side')
    assert(side.includes('有新版本 0.1.2'), `侧栏没说新版本号：${side}`)
    assert(side.includes('data-act="desktop-update-install"'), '侧栏那条点不动')
    assert(ui.loginView().includes('有新版本 0.1.2'), '登录页上也该提示——老壳可能连登录都过不去')
    const profile = ui.desktopUpdateInner('profile')
    assert(profile.includes('当前版本 0.1.1') && profile.includes('立即升级'), `个人设置里该给升级按钮：${profile}`)
  })

  await test('点了升级：调 install、轮询进度；失败时回到可点状态并说明原因', async () => {
    const { bridge, calls } = fakeBridge({
      check: AVAILABLE,
      install: { ...AVAILABLE, phase: 'downloading' },
      status: [
        { ...AVAILABLE, phase: 'downloading', downloaded: 50, total: 200 },
        { ...AVAILABLE, phase: 'available', error: '下载新版本失败：timeout' },
      ],
    })
    const ui = loadApp({ appPath, base, desktop: true, desktopUpdateBridge: bridge })
    await ui.checkDesktopUpdate(false)
    const seen = []
    const origStatus = bridge.status
    bridge.status = async () => {
      const view = await origStatus()
      seen.push(ui.desktopUpdateSlot('side'))
      return view
    }
    await ui.fire('click', el('button', { 'data-act': 'desktop-update-install' }))
    assert(calls.some((c) => c[0] === 'install'), `点了却没调 install：${JSON.stringify(calls)}`)
    assert(calls.filter((c) => c[0] === 'status').length === 2, `下载中该一直轮询到结束：${JSON.stringify(calls)}`)
    // 第二次取状态之前，槽里画的是第一次的进度：200 里下了 50。
    assert(seen[1] && seen[1].includes('正在下载 0.1.2 · 25%'), `进度没画出来：${seen[1]}`)
    const after = ui.desktopUpdateSlot('side')
    assert(after.includes('data-act="desktop-update-install"') && after.includes('上次没升级成功'), `失败后该能重试：${after}`)
    assert(ui.desktopUpdateInner('profile').includes('timeout'), '个人设置里该给出失败原因')
  })

  await test('install 本身报错（例如没有待装的版本）：不轮询，原因记下来', async () => {
    const bridge = {
      check: async () => AVAILABLE,
      install: async () => {
        throw '没有可安装的新版本，请先检查更新'
      },
      status: async () => {
        throw new Error('不该轮询')
      },
    }
    const ui = loadApp({ appPath, base, desktop: true, desktopUpdateBridge: bridge })
    await ui.checkDesktopUpdate(false)
    await ui.installDesktopUpdate()
    assert(ui.state.desktopUpdate.error === '没有可安装的新版本，请先检查更新', `原因没记下：${JSON.stringify(ui.state.desktopUpdate)}`)
    assert(ui.state.desktopUpdate.phase === 'available', '该留在可重试的状态')
  })

  await test('已是最新：侧栏空着，个人设置说「已是最新版本」；手动检查带 force', async () => {
    const { bridge, calls } = fakeBridge({ check: { ...AVAILABLE, phase: 'latest', version: null } })
    const ui = loadApp({ appPath, base, desktop: true, desktopUpdateBridge: bridge })
    await ui.fire('click', el('button', { 'data-act': 'desktop-update-check' }))
    assert(calls[0][0] === 'check' && calls[0][1] === true, `「检查更新」那一下该强制去问：${JSON.stringify(calls)}`)
    assert(ui.desktopUpdateSlot('side') === '<div class="satu-dupdate-slot" data-desktop-update="side"></div>', '已是最新时侧栏槽该是空的')
    assert(ui.desktopUpdateInner('profile').includes('已是最新版本'), '个人设置里没说已是最新')
  })
}
