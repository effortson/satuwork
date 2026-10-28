/**
 * 登录页「服务器」弹窗在界面这一侧的样子（gateway/ui/shell.js 的 gatewayServer*、actions.js 的
 * openGatewayServer / checkGatewayServer）。
 *
 * 壳子那头（desktop/src-tauri/src/server.rs 的 check、main.rs 的 use_gateway_server）在 node 里
 * 跑不起来，这里用一座假桥顶上 `window.__SATUWORK_SERVER__`，钉的是：
 *
 *   1. 浏览器里没有这座桥：登录页上没有那颗按钮。
 *   2. 桌面壳和手机壳里按钮标着现在连的主机；打开弹窗带出当前地址，和默认不同时给「恢复默认」。
 *   3. 「检测」只调 check、不调 use；没通过把壳子给的原因摆出来。
 *   4. 「检测并使用」调 use，进入切换中；空地址不打扰壳子。
 *
 * 不起 Gateway，也不调 boot()。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { loadApp } from './ui-dom.mjs'

function fakeBridge({ checkOk, checkErr, useErr } = {}) {
  const calls = []
  return {
    calls,
    bridge: {
      info: async () => {
        calls.push(['info'])
        return { current: 'https://gw.corp.example', default: 'https://satuwork.com' }
      },
      check: async (url) => {
        calls.push(['check', url])
        if (checkErr) throw checkErr
        return checkOk ?? url
      },
      use: async (url) => {
        calls.push(['use', url])
        if (useErr) throw useErr
      },
    },
  }
}

export async function runDesktopServer({ root, test, assert, log }) {
  const appPath = join(root, 'gateway/ui/app.js')
  const base = 'http://127.0.0.1:9'
  const gateway = 'https://gw.corp.example'
  log('\n# desktop-server')

  await test('浏览器里没有服务器桥：登录页上没有「服务器」按钮', async () => {
    const ui = loadApp({ appPath, base })
    assert(!ui.loginView().includes('gw-server-open'), '浏览器里登录页不该有服务器按钮')
    assert(ui.gatewayServerModal() === '', '没打开时不该画弹窗')
    const withBridge = loadApp({ appPath, base, serverBridge: fakeBridge().bridge, gateway })
    assert(!withBridge.loginView().includes('gw-server-open'), '普通网页即使存在同名对象也不能显示原生服务器配置')
  })

  await test('手机原生桥：检测只检测；切换成功后清掉旧票并重新加载登录页，失败时留在原页', async () => {
    const source = readFileSync(join(root, 'mobile/src-tauri/src/lib.rs'), 'utf8')
    const script = source.match(/const LINK_SCRIPT: &str = r#"([\s\S]*?)"#;/)?.[1]
      .replaceAll('__GATEWAY_URL__', JSON.stringify(gateway))
      .replaceAll('__OPEN_PATH__', JSON.stringify('/__satuwork_open'))
    assert(script, '手机壳的启动脚本没找到')
    const calls = []
    let fail = false
    const window = {
      __TAURI_INTERNALS__: {
        invoke: async (command, args) => {
          calls.push([command, args])
          if (command === 'use_gateway_server' && fail) throw new Error('HTTP 503')
          return command === 'check_gateway_server' ? 'http://gw.next:3080' : undefined
        },
      },
    }
    runInNewContext(script, {
      window,
      document: { addEventListener() {} },
      location: { replace: (path) => calls.push(['reload', path]) },
      clearToken: () => calls.push(['clear-token']),
    })
    const bridge = window.__SATUWORK_SERVER__
    await bridge.info()
    assert(await bridge.check('gw.next:3080') === 'http://gw.next:3080', '检测结果没传回页面')
    assert(!calls.some(([cmd]) => cmd === 'reload' || cmd === 'clear-token'), '单独检测不能退出登录或重载')
    fail = true
    let rejected = false
    try { await bridge.use('https://gw.bad') } catch { rejected = true }
    assert(rejected, '检测失败应传回页面')
    assert(!calls.some(([cmd]) => cmd === 'reload' || cmd === 'clear-token'), '切换失败不能退出登录或重载')
    fail = false
    await bridge.use('https://gw.next')
    assert(calls.some(([cmd, args]) => cmd === 'use_gateway_server' && args.url === 'https://gw.next'), '切换地址没传给原生命令')
    assert(calls.at(-2)?.[0] === 'clear-token' && calls.at(-1)?.[0] === 'reload' && calls.at(-1)?.[1] === '/login', '切换成功应先清票再重载登录页')
  })

  for (const [label, shell] of [['桌面壳', { desktop: true }], ['手机壳', { mobile: true }]]) {
    const shellTest = (name, fn) => test(`${label}：${name}`, fn)
    await shellTest('按钮标着当前主机，打开弹窗带出地址和「恢复默认」', async () => {
      const { bridge, calls } = fakeBridge()
      const ui = loadApp({ appPath, base, ...shell, serverBridge: bridge, gateway })
      const login = ui.loginView()
      assert(login.includes('data-act="gw-server-open"'), '登录页上该有服务器按钮')
      assert(login.includes('gw.corp.example'), `按钮该标着当前主机：${login}`)
      await ui.openGatewayServer()
      assert(calls.some((c) => c[0] === 'info'), '打开时该问一次壳子当前和默认地址')
      const modal = ui.gatewayServerModal()
      assert(modal.includes('id="gw-server-form"'), '弹窗没画出来')
      assert(modal.includes('value="https://gw.corp.example"'), `输入框该带出当前地址：${modal}`)
      assert(modal.includes('data-act="gw-server-default"') && modal.includes('satuwork.com'), '和默认不同时该给「恢复默认」')
    })

    await shellTest('「检测」只测不存；没通过把壳子给的原因摆出来', async () => {
      const { bridge, calls } = fakeBridge({ checkErr: '连不上 gw.bad:80（Connection refused）' })
      const ui = loadApp({ appPath, base, ...shell, serverBridge: bridge, gateway })
      await ui.openGatewayServer()
      ui.state.gwServer.url = ' gw.bad '
      await ui.checkGatewayServer(false)
      assert(calls.some((c) => c[0] === 'check' && c[1] === 'gw.bad'), `该拿去掉空白的地址去检测：${JSON.stringify(calls)}`)
      assert(!calls.some((c) => c[0] === 'use'), '只检测时不该切换')
      assert(ui.state.gwServer.phase === 'err', `该是失败：${ui.state.gwServer.phase}`)
      assert(ui.gatewayServerModal().includes('Connection refused'), '失败原因该摆在弹窗里')
    })

    await shellTest('「检测」通过给一句确认，仍不切换', async () => {
      const { bridge, calls } = fakeBridge({ checkOk: 'http://gw.ok:3080' })
      const ui = loadApp({ appPath, base, ...shell, serverBridge: bridge, gateway })
      await ui.openGatewayServer()
      ui.state.gwServer.url = 'gw.ok:3080'
      await ui.checkGatewayServer(false)
      assert(ui.state.gwServer.phase === 'ok', `该是通过：${ui.state.gwServer.phase}`)
      assert(ui.gatewayServerModal().includes('http://gw.ok:3080'), '通过时该显示规整后的地址')
      assert(!calls.some((c) => c[0] === 'use'), '只检测时不该切换')
    })

    await shellTest('「检测并使用」交给壳子切换；空地址不打扰壳子', async () => {
      const { bridge, calls } = fakeBridge()
      const ui = loadApp({ appPath, base, ...shell, serverBridge: bridge, gateway })
      await ui.openGatewayServer()
      ui.state.gwServer.url = '   '
      await ui.checkGatewayServer(true)
      assert(ui.state.gwServer.phase === 'err', '空地址该直接报错')
      assert(!calls.some((c) => c[0] === 'check' || c[0] === 'use'), '空地址不该调壳子')
      ui.state.gwServer.url = 'https://gw.next.example'
      await ui.checkGatewayServer(true)
      assert(calls.some((c) => c[0] === 'use' && c[1] === 'https://gw.next.example'), `该调 use：${JSON.stringify(calls)}`)
      assert(ui.state.gwServer.phase === 'switching', `该停在切换中：${ui.state.gwServer.phase}`)
      assert(ui.gatewayServerModal().includes('disabled'), '切换中按钮该锁住')
    })

    await shellTest('「检测并使用」没通过：留在弹窗里说明原因', async () => {
      const { bridge } = fakeBridge({ useErr: '/health 回了 HTTP 404，这个地址不像是 Satuwork Gateway' })
      const ui = loadApp({ appPath, base, ...shell, serverBridge: bridge, gateway })
      await ui.openGatewayServer()
      ui.state.gwServer.url = 'https://example.com'
      await ui.checkGatewayServer(true)
      assert(ui.state.gwServer.phase === 'err', `该是失败：${ui.state.gwServer.phase}`)
      assert(ui.gatewayServerModal().includes('HTTP 404'), '失败原因该摆在弹窗里')
    })
  }
}
