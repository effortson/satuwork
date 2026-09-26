# satuwork-desktop

桌面壳。**界面打在包里**——`gateway/ui` 那批分片原样拷进包（`pnpm prepare:ui`），由壳子用自己的
`satu://` 协议发出来（main.rs 的 `serve_ui`，找不到的路径回 index.html，单页路由刷新也不丢）。
壳子记住「连哪台 Gateway」，注入 `window.__SATUWORK_GATEWAY__`，页面里所有打 Gateway 的请求在
`ui/data.js` 的 `swFetch` 那一层接上这个前缀。

以前包里没有前端，窗口直接装 Gateway 发的页面，理由是「前端永远不会和服务端漂开」。改成内置
是 docs/adr-gateway-vercel-neon.md §4 的决定：桌面端要是一个自己 hold 自己逻辑的系统，本地 Bot 的
会话不经过 Gateway、日常任务自己领。代价照实写：**界面版本跟着桌面端发版走**，Gateway 升级了
界面不会自己变，要发一版桌面端；两边的接口契约靠 e2e 钉着。

跨源随之而来：页面源是 `satu://localhost`（Windows 上 Tauri 映射成 `http://satu.localhost`），
Gateway（`GATEWAY_CORS_ORIGINS` 之外内置了这几个源）、席位机器的管家（对话流、名单流直连）、本地
Bot 的守卫三处都对它开 CORS；管家那张桌面 cookie 在 https 下改成 `SameSite=None; Secure`，否则
跨站的 iframe 里浏览器不发它。

## 跑

```bash
pnpm --filter satuwork-desktop dev
```

第一次打开是「连接到 Gateway」那一屏；填过一次就直接进去了。地址存在
`~/Library/Application Support/sg.dami.satuwork/server.txt`（Windows 在
`%APPDATA%`，Linux 在 `~/.config`）。要改地址走菜单「服务器 → 切换服务器…」。

登录票在桌面壳里按 Gateway 来源持久保存：关掉窗口或退出应用后再打开会恢复登录；在
个人设置里点「退出登录」仍会立即清掉。浏览器版继续使用 `sessionStorage`，关掉标签页
不会长期保留登录。

排查时可以绕过存的那个地址，它**不写盘**：

```bash
SATUWORK_SERVER=http://127.0.0.1:3080 pnpm --filter satuwork-desktop dev
```

## 本地 Bot 直连本机

本地 Bot（建 Bot 时选「本地」的那种）由壳子在这台电脑上起一个 Bot 进程，听 127.0.0.1 的一个
随机端口。**它的对话不经过 Gateway。** 页面拿到壳子报的端口（`__SATUWORK_LOCAL_BOT__.status`
里的 `port`）和 Gateway 发的票（`/runtime/bots/:id/local-bootstrap`），把这颗 Bot 的会话
请求（取会话、事件流、历史、发消息、文件、工作区）直接改道到本机，见 gateway/ui/data.js 的
`localRoute`。别的请求——公司模版、记忆、Skill、账号——照旧打 Gateway。

那把票是**桌面端专用的一套**（Gateway 迁移 0041），不是远程席位那一套，而且跟登录票同生共死：
改口令、被管理员重置之后它一起作废。页面重新登录（或改口令拿到新登录票）后会再要一次，交给
壳子的 `start`——同一把什么都不动，换了一把就用新票把跑着的本地 Bot 重起一遍（`start_local_bot`）。

以前这条路是「页面 → Gateway → 一条 Bot 主动连到 Gateway 的 WebSocket 反向隧道 → 本机」，
为的是让 Gateway 能主动打进员工的电脑。隧道拆掉了（docs/adr-gateway-vercel-neon.md §4）：
Gateway 从此不知道本地 Bot 在不在跑，所以

- 名单上本地 Bot 那一行的状态由壳子报，只在桌面端里成立；在普通浏览器里它永远是「本机未运行」。
- 本地 Bot 的日常任务 Gateway 不再调度（它连不到本机）；Bot 进程自己每半分钟去领（bot/src/local-routines），电脑关着、应用没开就没人领，Gateway 只是排着。
- 转人工、审计拉全文这类 Gateway 主动找 Bot 的事，对本地 Bot 都是「实例还没上线」。

跨源：页面的源是 Gateway，请求打 127.0.0.1，Bot 的守卫只对 Gateway 那一个源开 CORS
（bot/src/guard/index.ts），Gateway 的 CSP 放了 `connect-src http://127.0.0.1:*`。

运行时更新：壳子在第一颗本地 Bot 启动前查一次，之后**每小时**再查一次；查到只下载、只写
PENDING，切换仍留给下一次「没有本地 Bot 在跑」的启动。

## 链接与「连不上」

两件在浏览器里天经地义、在壳子里得自己接的事：

- **外链**。`target="_blank"` 和 `window.open()` 在裸 webview 里是**空操作**——不报错、
  不开窗、连请求都不发（实测）。而 gateway/ui 的外链一律带 `target="_blank"`，所以不
  接的话，对话里每个链接和那个「打开桌面」按钮全是死的。现在：同源的另开一扇应用
  窗口，站外的交给系统浏览器。普通的站外链接也一样——不接的话它会把唯一的窗口整个
  带走，而这里没有地址栏也没有后退。
  - **内嵌桌面是这条守卫的例外**（`is_seat_desktop`）。右栏那块屏是一个指向席位机器的
    iframe（`{directUrl}/seats/<席位>/vnc/`），而它的加载在守卫眼里也是一次 http(s)
    导航——wry 的 `navigation_policy` 不区分主框架和子框架，`targetFrame.isMainFrame`
    压根没传上来。所以路径形如 `/seats/<席位>/vnc` 的放行，否则表现是**桌面从窗口里
    跳到系统浏览器里打开**，而配置上看不出任何毛病。判据只认路径不认源：机器的直连
    地址按公司各不相同，壳子这头无从枚举。
- **连不上**。WKWebView 没有内建错误页，装不上东西时窗口里一个字都没有。所以进主窗口
  之前先敲一下 TCP：敲不开就停在设置屏并说明原因，也**不把这个地址写进 server.txt**
  ——写了的话下次启动会直奔那个地址，又是一片空白。代价：敲的只是 TCP，端口通着但
  服务坏了这里看不出来。

## 出包

```bash
pnpm --filter satuwork-desktop build
```

构建前会把当前平台的 Node 与 Bot 运行时一起放进资源目录；产物在
`src-tauri/target/release/bundle/`。因此现在的安装包会明显大于只有 WebView 壳时的
3.1 MB，但用户机器不需要另装 Node。

本地 Bot 默认工作目录是 `文稿/Satuwork/<bot-id>/`，会话与本地索引存在应用数据目录。
浏览器工具会使用本机已安装的 Chrome、Chromium 或 Edge，并为每颗本地 Bot 建立独立的
浏览器 profile；它不会读取用户日常 Chrome 的个人 profile。首次访问需要登录的网站时，
可直接在弹出的 Bot 浏览器窗口内登录，后续会保留该登录状态。
Desktop 退出时本地进程会一起退出，再次打开并恢复登录后会自动启动。当前本地模式只开放
受工作区约束的文件工具；真 shell 暂不开放，避免它用 `cd /` 绕过跨目录审批边界。需要
访问其他目录时，在对话右栏点「批准访问其他文件夹」，系统选择器里由用户亲自选择；批准
后的目录挂在工作区的 `External/` 下，记录按 Bot 独立保存。

### 本地 Bot 运行时自动升级

Desktop 壳与本地 Bot 分开发版。每次 Desktop 启动、第一颗本地 Bot 拉起之前，会用当前
席位票向 Gateway 查询适合本机操作系统和架构的 `local-bot` 包：

1. 包先下载到临时文件，并核对声明大小和 SHA-256；下载地址必须与当前 Gateway 同源。
2. 校验通过后解到 `local-runtime/releases/<version>/`，旧版本目录保留。
3. 没有 Bot 在运行时才原子切换 `CURRENT`；已有任务运行时绝不重启或混用版本，留到下一次
   Desktop 启动再切换。
4. 新运行时连进程都无法拉起时，自动把 `CURRENT` 指回旧版本并重试。网络、校验或兼容性
   错误也不会阻止旧版本启动，界面会给出升级失败提示。

每个运行时包登记时各带一个**最低 Desktop 版本**，来源是 bot/package.json 的
`minDesktopVersion`：bot 代码开始依赖某一版壳才有的东西时，把它抬到那一版。检查更新时
壳会带上自己的版本，Gateway 给它装得了的最新一版；够得着的已经装上、更新的又要新壳时，
仍发最新那版，由壳比对后提示先升级 Desktop，不会硬装。运行时状态保存在应用数据
目录的 `local-runtime/{CURRENT,PENDING,LAST_ERROR}`，可用于排查；每颗 Bot 的启动输出保存在
`local-bots/<bot-id>/runtime.log`（超过 2 MiB 自动轮换）。正常使用不需要手工维护。

**不能交叉编译**：Windows 包要 Windows 机器，Linux 包要 Linux 机器（和管家那边一样的
道理，只是原因不同——这里是系统 webview 的开发库）。三个系统各要一台 runner。

现在打出来的包**没有签名**：macOS 上别人下载会被 Gatekeeper 拦（自己 build 的不会，
隔离标记只加在下载来的文件上），Windows 上会弹 SmartScreen。签名和公证要先有证书，
见下面「还没做的事」。

## webview 自检

Tauri 装的是系统 webview——Windows 是 WebView2（Chromium）、macOS 是 WKWebView、
Linux 是 WebKitGTK，**它们不是同一个浏览器**。gateway/ui 靠的几样东西恰好都在各家
差异最大的那一档，所以换一个目标系统就该重跑一遍 [probe/](probe/)：

```bash
node desktop/probe/server.mjs
```

```bash
SATUWORK_SERVER=http://127.0.0.1:4321 pnpm --filter satuwork-desktop dev
```

结论会回填到起靶子的那个终端，不用有人守着屏幕看。

已经验过的（macOS 26.5 / WKWebView 605.1.15，Windows 和 Linux 两列都还没跑）：

| 验的东西 | 对应哪一处 | macOS |
|---|---|---|
| `fetch` 流式读取 | 聊天（chat.js 的 SSE） | 过，5 次增量读到，首字节 ~155ms |
| WebSocket | 桌面画面 | 过 |
| 302 + SameSite=Lax cookie（**同源**） | 旧架构里 Gateway 同域反代的桌面入口 | 过 |
| 302 + SameSite=Lax cookie（**跨站**） | 曾经的桌面入口 | **不过，而且不可能过**：WKWebView 拦掉一切第三方 cookie，`SameSite=None; Secure` 也没用。桌面因此改成**票写进路径**（`/seats/:id/vnc/t/<票>/…`，管家 0.1.24 起），不再依赖 cookie |
| `blob:` 预览 iframe | 附件预览 | 过 |
| `<a download>` | 附件下载 | 过，静默落到 ~/Downloads，不弹框 |
| `target="_blank"`（同源） | 「打开桌面」按钮 | 过（另开一扇应用窗口） |
| `window.open()`（同源） | 同上 | 过 |
| 站外链接 | markdown 里贴的网址 | 过（交给系统浏览器，窗口没被带走） |
| localStorage / sessionStorage | 登录态与偏好 | 过 |
| 局域网明文 http | 内网部署 | 过，**不加 ATS 那段也能过** |

Linux 那一列是三列里最可能出问题的。真要发 Linux 包，先跑这个靶子再排期。

## 还没做的事

按「值不值得下一步做」排的，不是按难度：

- **签名与公证**。macOS 要 Apple 开发者账号（99 美元/年）+ 公证；Windows 不签名就
  一路 SmartScreen。这是发给外人之前唯一的硬门槛，代码上没有工作量，全是行政成本。
- **Desktop 壳自动更新**（`tauri-plugin-updater`）。本地 Bot 运行时已经能独立静默升级，
  但 Rust 壳、内置 Node、系统权限声明变更仍然必须发新安装器；这一层需要签名和公证后
  才适合接自动更新。
- **单实例 + 托盘 + 通知**。这三样是「装成桌面端」之后用户会立刻期待的东西，也是
  相对浏览器唯一说得出口的增量。通知要接的是聊天那条流。
- **登录态**。token 现在在 `sessionStorage`（[gateway/ui/state.js](../gateway/ui/state.js)），
  关窗即失效。浏览器里合理，桌面端会被当成 bug——这是产品决定，不是技术问题。
- **发版 CI**。已接入 `.github/workflows/desktop-release.yml`：`desktop-v*` tag 触发
  或手动触发，出 macOS（Apple 芯片 / Intel）与 Windows 三档包。
  下载页（[gateway/ui/pages-download.js](../gateway/ui/pages-download.js)）指着那个 tag 下面的
  资产名，**两边是一对**：Release 里必须正好是这三个文件：

  ```
  Satuwork_<版本>_x64-setup.exe   Windows
  Satuwork_<版本>_aarch64.dmg     macOS / Apple 芯片
  Satuwork_<版本>_x64.dmg         macOS / Intel
  ```

  第一版发出去之后，核对那个文件里的 `DL_VERSION` 对上，并关掉 `DL_PENDING`。Linux 暂未开包。
- **图标**。现在这套是拿 64×64 的 logo 放大到 1024 生成的，糊。要一份真正的大图。
