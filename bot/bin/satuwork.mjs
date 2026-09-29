#!/usr/bin/env node
// Satuwork 的启动器。
//
// 内容跟 cordis 自带的 bin.js 是同一件事：建根 Context、挂 Loader、让它读
// cordis.yml。自己写一份是为了把包的选择写明白——我们用的是 DeepSeek vendor 的
// 那套框架包（@deepseek-ai/cordis 4.0.1），不是上游的 4.0.0-rc.8：上游主线还在
// RC，vendored 那份是 dsh 每天在跑的。
//
// package.json 里另有一条别名把 `cordis` 指到同一个物理包，因为上游的
// @cordisjs/plugin-server 是 `import { Service } from 'cordis'`。没有这条别名就会
// 加载两份框架，Service 和 Context 不是同一个类，服务注册不上去。
//
// 注意这里用的是**产品代码之外**的东西：框架本身。dsh 的产品包（dsh-agent、
// dsh-llm、dsh-tools…）一个都不用，那些我们自己写。

import { pathToFileURL } from 'node:url'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vendored from '@deepseek-ai/cordis'
import * as aliased from 'cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { loadSeatSecrets } from '../src/seat-secrets.ts'
import { loadGatewayUrlOverride } from '../src/gateway-url.ts'

// **第一件事**：远程席位的两把凭据从 fd 0 读（见 src/seat-secrets.ts），读完就把 fd 0
// 换成 /dev/null。必须赶在任何子进程起来之前——之后起的子进程才碰不到那个 fd。
// 没设 SATUWORK_SECRETS_STDIN（本地桌面 bot、开发）时什么都不做。
const seatSecrets = loadSeatSecrets()
if (seatSecrets.length) console.log(`satuwork: 从标准输入读到席位凭据 ${seatSecrets.join(', ')}`)
// 上次从 Gateway 学到的新地址（带席位票做的 HMAC，见 src/gateway-url.ts）。要在凭据之后、
// 任何插件读 GATEWAY_URL 之前。只在远程席位上生效。
loadGatewayUrlOverride({ info: (s) => console.log(s), warn: (s) => console.warn(s) })

const { Context } = vendored

/**
 * Desktop 开发进程被 `Ctrl-C` / 热重载直接结束时，Tauri 来不及跑 Exit 回调，macOS 会把
 * 本地 Bot 重新挂到 pid 1。盯住启动它的 Desktop，主人不在了就结束整个本地进程组，
 * 连同这颗 Bot 拉起的独立 Chrome 一起收掉。远程部署没有这个变量，行为完全不变。
 */
const desktopPid = Number(process.env.SATUWORK_DESKTOP_PID)
if (
  process.env.SATUWORK_RUNTIME_KIND === 'local' &&
  Number.isSafeInteger(desktopPid) &&
  desktopPid > 1
) {
  const ownerWatch = setInterval(() => {
    try {
      process.kill(desktopPid, 0)
      if (process.ppid !== 1) return
    } catch {
      // 启动它的 Desktop 已经不存在。
    }
    clearInterval(ownerWatch)
    if (process.platform !== 'win32') {
      try {
        process.kill(-process.pid, 'SIGTERM')
        return
      } catch {
        // 不是进程组长时回落到只结束自己。
      }
    }
    process.exit(0)
  }, 1_000)
  ownerWatch.unref()
}

// 别名断线时要在这里响亮地失败。否则症状会是「server 服务找不到」——因为
// plugin-server 把自己注册到了另一份框架的 Context 上，排查起来完全指错方向。
if (aliased.Context !== vendored.Context) {
  throw new Error(
    'satuwork: `cordis` 与 `@deepseek-ai/cordis` 解析到了两份不同的框架。' +
      'package.json 里 "cordis": "npm:@deepseek-ai/cordis@…" 这条别名可能被破坏了。',
  )
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const ctx = new Context()
// 相对说明符（'./src/web/index.ts'）按这个基址解析，所以从任何工作目录启动都一样。
ctx.baseUrl = pathToFileURL(root).href + '/'

// 启动就把**用的是哪个数据目录**说出来。这台实例的账号、会话、历史全在那一份库
// 里，而它可以被 $SATUWORK_HOME 换掉——不打出来的话，「同一个地址、口令却不对」
// 这种事根本无从查起：看到的是同一个端口，背后却是另一份数据。
const { satuworkHome } = await import('../src/home.ts')
console.log(`satuwork: 数据目录 ${satuworkHome()}${process.env.SATUWORK_HOME ? '（来自 $SATUWORK_HOME）' : ''}`)

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@deepseek-ai/cordis-plugin-include',
  config: { path: './cordis.yml' },
})
