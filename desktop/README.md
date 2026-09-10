# satuwork-desktop

桌面壳。**包里没有前端**——界面还是 gateway/ui 那一份，由 Gateway 自己发；这个壳只
记住「连哪台 Gateway」，然后开一个没有地址栏的窗口装它。

为什么不把 ui 打进包里：那样每条 fetch 都成了跨源请求，Gateway 得加 CORS，而会当场
坏掉的是对话页右栏那块桌面——它那张 `satu_desk_*` 是 SameSite=Lax 的 cookie，跨源
之后浏览器连存都不存（[gateway/src/desktop.ts](../gateway/src/desktop.ts) 开头那段
说的就是这件事）。同源是那条路唯一的前提。

代价：没网就是一片空白。这不亏——这个界面没有一屏是离线能用的。换来的是前端永远不会
和服务端漂开：Gateway 升级了，桌面端下次打开就是新的，壳子不用重发。

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
里的 `port`）和 Gateway 发的席位票（`/runtime/bots/:id/local-bootstrap`），把这颗 Bot 的会话
请求（取会话、事件流、历史、发消息、文件、工作区）直接改道到本机，见 gateway/ui/data.js 的
`localRoute`。别的请求——公司模版、记忆、Skill、账号——照旧打 Gateway。

以前这条路是「页面 → Gateway → 一条 Bot 主动连到 Gateway 的 WebSocket 反向隧道 → 本机」，
为的是让 Gateway 能主动打进员工的电脑。隧道拆掉了（docs/adr-gateway-vercel-neon.md §4）：
Gateway 从此不知道本地 Bot 在不在跑，所以

- 名单上本地 Bot 那一行的状态由壳子报，只在桌面端里成立；在普通浏览器里它永远是「本机未运行」。
- 本地 Bot 的日常任务 Gateway 不再调度（它连不到本机），等桌面端自己的调度器；在那之前静静排着。
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

运行时要求更高版本 Desktop 时不会硬装，会提示先升级 Desktop。运行时状态保存在应用数据
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
| 302 + SameSite=Lax cookie | 桌面入口（desktop.ts） | 过 |
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
- **发版 CI**。`check.yml` 现在有一档 `cargo check`（顺带是 Linux 那边唯一的编译信号），
  但**打包**还没有：三个系统的 matrix + `desktop-v*` tag，形状照抄
  [.github/workflows/manager-release.yml](../.github/workflows/manager-release.yml)。
- **图标**。现在这套是拿 64×64 的 logo 放大到 1024 生成的，糊。要一份真正的大图。
