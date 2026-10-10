# ADR：逻辑层抽成 `core` 包，移动端用 Tauri 2 mobile 装同一份界面

- 状态：**已接受**（2026-10-10），**部分实施**：第 1–4 步（Web 侧，core 包）已落地；第 5–6 步的 Expo 移动端做过、同日**回滚**，改走 **Tauri 2 mobile**（见 §2.3 与 §5），第 5 步在做
- 影响范围：gateway/ui、gateway/src/http.ts、gateway/scripts、e2e/ui-dom.mjs、desktop/（间接）、新增 core/ 与 mobile/
- 前置阅读：[gateway-runtime.md](gateway-runtime.md)；[adr-gateway-vercel-neon.md](adr-gateway-vercel-neon.md) §4、§7；[session-event-field-map.md](session-event-field-map.md)；[chat-references.md](chat-references.md)

## 0. 一句话

**不把 gateway/ui 改成 React，也不追求「Web 和手机共享组件」。** 把界面里不碰 DOM 的那一层
抽成一个 TypeScript 包 `core`，gateway/ui 照旧是一串普通脚本、通过一个打包产物
`core.js` 引它（先例：[blob-client.js](../gateway/ui/blob-client.js)）；移动端是一个 **Tauri 2
mobile 的壳**，和桌面端一样把 gateway/ui 原样装进包里（§2.3 的更正），产品上**只承诺对话**。
`core` 这一层因此两头都在用：Web 和手机装的是同一份界面。

## 1. 背景：为什么不是「React 化 + React Native 共享组件」

### 1.1 现状

| 项 | 数字 / 事实 |
|---|---|
| gateway/ui 代码量 | 约 39k 行（JS 约 33k，CSS 约 4.3k） |
| 加载方式 | 20 个 classic script 按顺序共享一个全局作用域（[index.html](../gateway/ui/index.html)，顺序同 http.ts 的 `UI_PARTS`） |
| 构建 | 没有。esbuild 只用来打 `blob-client.js` 和 Vercel 产物 |
| 渲染 | `render()` 整页换 `innerHTML`（[render.js](../gateway/ui/render.js)）；对话正文是 `paintChat` 增量 DOM（[chat.js](../gateway/ui/chat.js)，一万行） |
| 周边绑定 | e2e 的 [ui-dom.mjs](../e2e/ui-dom.mjs) 按 `data-app-part` 顺序把源码拼起来塞进 `new Function`；桌面端 [prepare-ui.mjs](../desktop/scripts/prepare-ui.mjs) 原样拷 gateway/ui；CSP 的 `script-src 'self'` 不带 `'unsafe-inline'` |
| 桌面端 | 界面跟安装包走，gateway/ui 一改就要发桌面版 |

### 1.2 React 化等于重写

`innerHTML` 整页换和 React 的虚拟 DOM 没有共存的办法：要么整页还是字符串，要么整页是组件树。
能做的只有「壳先换、按页重写」，chat.js 那一万行是最后一块也是最难的一块。这不是改造，是把
39k 行重写一遍，外加 e2e 两套 UI 测试重写。

### 1.3 Web 组件和 React Native 组件本来就不是一套

React Web 写的是 `div` + CSS，React Native 写的是 `View` / `Text` / `StyleSheet`。要真共享 UI
只有一条路：Web 端也用 RN 写法、经 react-native-web 跑在浏览器里。代价：

- 现有 4.3k 行 CSS 作废；
- markdown.js 里 KaTeX / highlight.js / Mermaid 是按需从 CDN 挂 `<script>`（[ui-cdn.ts](../gateway/src/ui-cdn.ts)），RN 上没有 DOM，全部换实现；
- Office 预览（iframe + [office-view.js](../gateway/ui/office-view.js)）、拖拽上传、画板、noVNC 桌面、键盘快捷键、`@` 与 `/` 弹层，都是浏览器能力；
- 实践里页面级仍然两边各写，真正共用的只剩按钮、列表项这一级。

花重写的代价，换来的共享面很小。

### 1.4 真正能共享、也值得共享的是逻辑层

界面里已经有一整层不碰 DOM 的东西：Gateway 地址与请求封装、本地 Bot 改道表、译表与 `t()`、
金额时间格式化、SSE 解析、会话事件折叠（`fold`）、回执认领（`mergePending`）、退避表。
它们今天散在全局作用域里，和 `state` / `render()` 缠在一起，但缠的地方是**调用点**，不是
算法本身。把它们抽出来，Web 一行不少地继续用，手机端拿同一份——这才是「共享」。

## 2. 决定

### 2.1 决定一：`core` 的边界按「能不能在 node 里跑」划

进 `core` 的条件只有一条：**不引用 `window` / `document` / `localStorage` / `history`，
所有外部依赖（fetch、票的存取、语言、401 之后干什么）由宿主注入。** 按这条尺子逐个文件过：

| 今天在哪 | 什么 | 进 core？ | 怎么处理 |
|---|---|---|---|
| data.js | `gatewayBase` / `gatewayAbs` / `swFetch` / `api()` | 进 | 改成 `createApi({ fetch, baseUrl, tokens, t, onUnauthorized })`。`api()` 里 401 那一支今天直接 `endSignedIn()` + 改 `state.path` + `render()`，全部换成调 `onUnauthorized()`，由 Web 宿主做原来那三件事 |
| data.js | `localBots` / `localSessions` / `localRoute` / `renewLocalTicket` | 进 | 改道表是纯函数；「重新要票」那一跳（`startDesktopLocalBot`）注入。移动端永远不登记本地 Bot，这张表就是空的 |
| data.js | `flash` / `dismissFlash` / 七十个 `load*` / `loadPage` | 不进 | 它们写 `state`、调 `render()`、碰 `document`。第一期不动。`core` 另给一组**纯请求函数**（`getMe` / `listRuntimeBots` / `getBotSession` / `getHistory` / `postMessage` / `abort` / `listApprovals` / `decideApproval` / `listHandoffs` / `listTodos`），Web 的 `load*` 以后逐个改成「调它、写 state」 |
| state.js | 转义、金额与时间、角色判断、路径解析（文件头自己写了「都是纯函数」） | 进 | 原样搬，改 export |
| state.js | `state` 对象本身 | 不进 | Web 全局的；移动端用 React state |
| state.js | 票的存取（`token()` / `setToken` / 桌面端 `__SATUWORK_DESKTOP__` 判断，384–425 行） | 抽接口 | `TokenStore { get, set, clear }`。Web 实现用 localStorage（含今天那段 legacy 迁移），RN 实现用 expo-secure-store |
| prefs.js | `t()` / `errText()` / `localeMode` | 进 | 语言的读写注入；`t()` 的查表逻辑原样 |
| prefs.js | 主题、`matchMedia`、侧栏宽度、图标 SVG、导航表 | 不进 | 纯 Web |
| i18n.js | `window.SATU_I18N` 字典 | 进 | 变成模块导出；Web 侧由 core.js 继续挂到 `window.SATU_I18N`，调用点不动 |
| markdown.js | 文本 → HTML 的解析（前半部分） | 进（已验证能拆） | 第 28–739 行只碰字符串，唯一的外部依赖是 `window.t` 和「人点过加载的站外图片」那张表，两样都由宿主注入（`createMarkdown({ t })` 返回的 `loadedImages`） |
| markdown.js | KaTeX / hljs / Mermaid 按需加载、复制、下载、图片兜底 | 不进 | 纯 Web |
| chat.js | `sseEvents`、`fold`、`noteBotEvent` 的归并部分、`refreshSum`、`mergePending`、`chatCursor`、`noteRosterFrame`、`CHAT_BACKOFF` / `ROSTER_BACKOFF` / `CHAT_ALIVE_MS`、`maxSeqOf` | 进 | 这是手机端最需要的一层，也是最容易搬坏的一层。`fold` 里有 Telegram 来源、渠道标签等细节，靠 e2e 的 chat-fold.mjs 兜底 |
| chat.js | `startChatStream` / `retryChatStream` / `startRosterStream` 的开流、退避、503 与 401/403/404 分治 | 进，改形 | 改写成不碰 `state` 的 `openEventStream({ fetch, url, token, after, signal, onEvent, onStatus })` 和 `openRosterStream(...)`。状态码分治的规则原样（503 与 5xx 退避重试、401/403/404 认输、活够 10 秒档位归零）。Web 的 `startChatStream` 只剩「拿事件写 `botStreams`、画」 |
| chat.js | 其余九千行（paint*、预览、工作区、桌面、日志、画板、弹层） | 不进 | 纯 Web |
| docs/session-event-field-map.md | 事件信封与各族的 `data` 键 | 进 | 落成 TS 类型 `core/src/protocol/` |

### 2.2 决定二：gateway/ui 消费 `core` 的方式是一个打包产物，不改成 module

gateway/ui 保持「无构建、普通脚本」。`core` 用 esbuild 打成一个 IIFE
`gateway/ui/core.js`，挂全局 `SatuCore`，脚本是 `gateway/scripts/build-core.mjs`，和
[build-blob-client.mjs](../gateway/scripts/build-blob-client.mjs) 同一条路。

- [index.html](../gateway/ui/index.html)：`<script src="/core.js">` 放在 i18n.js 之前（i18n 的字典从它来）。
- [http.ts](../gateway/src/http.ts)：`ROOT_FILES` 加 `core.js`。**不进 `UI_PARTS`**：那张表是给 e2e 拼源码用的，core.js 是产物，e2e 垫片要单独把它 `new Function` 进去，在拼好的 app 源码之前。
- gateway/ui 里的函数名一个不改。data.js 的 `api` 变成 `const api = SatuCore.api` 这类一行转接，prefs.js 的 `t` 同理。调用点不动，e2e 不用改断言。

**产物提交进仓库**，理由：不提交就要在 `dev.mjs`、`vercel-build.mjs`、桌面端 `prepare:ui`、
e2e 四处各加一次构建，漏一处就是一处 404。代价是每个改 core 的 PR 带一坨压缩后的 diff。
在 check.yml 加一步「重新打一遍，`git diff --exit-code gateway/ui/core.js`」防止源码和产物漂开。

### 2.3 决定三：移动端是 Tauri 2 mobile 的壳，装的是同一份 gateway/ui

> **2026-10-10 更正（二）**：移动端改走 **Tauri 2 mobile**。桌面端已经是 Tauri 2 的壳
> （desktop/），它本身支持 iOS 和 Android：手机端就是「同一个思路的壳再多两个目标」——
> gateway/ui 原样打进包、`satu://localhost` 做页面源、注入 Gateway 地址，Gateway / 管家 /
> 本地 Bot 守卫三处的 CORS 白名单早就认这个源，一行不用加。不再有「移动端自己的四屏」，
> 下面那张表和「几个具体选择」保留作协议参考（手机上跑的就是 Web 那份 chat.js）。
>
> 和 Expo 路线相比，共享面从「逻辑层」变成「整份界面」，代价是手机上的界面要靠
> gateway/ui 现有的窄屏抽屉撑着，管理页在手机上能用但不好用——产品上仍只承诺对话。
> 推送（§2.5）的客户端那一截换成 Tauri 的原生插件（官方 notification 插件只做本地通知，
> 远程推送要自己写几十行 Swift / Kotlin 或用社区插件），Gateway 侧不变。
>
> **2026-10-10 更正（一）**：这一节原本定的是 Expo + Expo Router。第 5、6 步按它做完并在模拟器里验过
> （#325 已合、#326 未合），当日决定**不用 Expo**：#325 用 revert 撤回，#326 关闭。
> 那两步验出来的几条经验，仍然有用：对话流、上传、审批、名单流的协议细节见下面的表和 Web 的
> chat.js；受控输入框在 JS 线程慢时会丢字（Web 那份 chat.js 没有这个问题）。

目录 `mobile/`，进 pnpm workspace，结构照 desktop/：`src-tauri/` 是 Rust 壳（lib.rs 一个文件：
serve_ui、注入、导航守卫），`scripts/prepare-ui.mjs` 把 gateway/ui 拷进包，`src-tauri/gen/apple/`
是 `tauri ios init` 生成的 Xcode 工程（**进版本库**，签名、ATS 这些改在里面）。

手机壳和桌面壳的差别（都是「少」）：

| | 桌面壳 | 手机壳 |
|---|---|---|
| Gateway 地址 | 正式包锁死 satuwork.com；debug 有设置屏和菜单 | 正式包锁死；debug 读 `mobile/src-tauri/dev-server.txt`（不进版本库），没有设置屏 |
| 窗口 | 设置屏 + 主窗口，同源 `_blank` 另开一扇 | 一扇；同源 `_blank`（「打开桌面」）换成 Gateway 的源交给 Safari |
| 本地 Bot、运行时下载、自升级、菜单 | 有 | 没有；升级走商店 |
| 页面标记 | `__SATUWORK_DESKTOP__` | `__SATUWORK_MOBILE__`；state.js 的 `appShell()` 两个都认（票落 localStorage、`/` 是登录屏、不给「下载桌面端」） |
| 票 | localStorage | localStorage（iOS 的应用容器本身静态加密；换 stronghold 留作后话） |

serve_ui / CSP / 导航守卫那几段是从桌面壳抄的，**两边要一起改**；抽成共用 crate 是后话。

原 Expo 版要做的四屏（保留作接口参考）：

| 屏 | 用的接口 | core 里对应 |
|---|---|---|
| 登录 | `POST /auth/login` → `{ token, account, company }` | `api` + `TokenStore` |
| Bot 名单 | `GET /runtime/bots`（带 `runtime.streamUrl` / `uploadUrl` / `rosterStreamUrl`）+ 名单流 | `listRuntimeBots` + `openRosterStream` + `noteRosterFrame` |
| 对话 | `GET /runtime/bots/:id/session` → `GET …/history?turns=N` → SSE `{streamUrl}/sessions/:id/events?after=` → `POST …/messages` / `abort` / `approvals/:callId` | `getHistory` + `openEventStream` + `fold` + `mergePending` + `postMessage` |
| 设置 | Gateway 地址、语言、退出 | `TokenStore.clear` + `setLocale` |

Expo 版明确不做的那串（管理页、文件树、noVNC、Office 预览、画板……）在 Tauri 壳里**自然就有**，
只是没按手机调过；本地 Bot 仍然没有（没有桥，页面上的入口不出现）。

Expo 版的几个具体选择（已作废，留作对照）：

- **流**：`expo/fetch` 的响应 `body.getReader()` 可用，而且在 iOS / Android 上默认就是全局 `fetch`（Expo 文档「Streaming fetch with expo/fetch」）。core 的 `sseEvents` 直接吃它，不另装 SSE 库。
- **Markdown**：第一期用 react-native-markdown-display 直接渲染助手文本；公式和 Mermaid 显示源码块。不复用 Web 那份 HTML 输出。
- **票**：expo-secure-store。
- **Gateway 地址**：首次启动输入（Vercel 线上和自托管两种），后续记住。
- **图片附件**：走 `uploadUrl` 直传机器（和 Web 一样不经 Gateway），第一期只做拍照 / 相册选图。

### 2.4 决定四：直连是硬约束，手机只能用有公网 `directUrl` 的 Bot

对话 SSE 和上传**只直连席位机器**，Gateway 上的反代已经拆了
（[adr-gateway-vercel-neon.md](adr-gateway-vercel-neon.md) §7；chat.js `directStreamBase` 上面那段）。
手机上的后果：

- 机器的 `directUrl` 是内网地址（本地开发那台 `192.168.64.1`）时，手机不在同一网段就连不上。名单里 `streamUrl` 为空、或连不上的 Bot，在手机上灰掉并写明原因，和 Web 的 `NO_DIRECT_STREAM_MSG` 同一句话。
- 桌面端里的本地 Bot（127.0.0.1）手机上永远不出现。
- CORS：页面源是 `satu://localhost`（Android 上 `http://satu.localhost`），Gateway 的 CORS_ORIGINS、管家 proxy.ts 和本地 Bot 守卫的 DESKTOP_ORIGINS 都已经认它（桌面端铺的路）。

### 2.5 决定五：推送要新加一条链路，排到第三阶段

今天没有任何推送基础设施，而且结构上没有谁知道「这一轮跑完了」：事件在席位机器上，
Gateway 无状态、不经手对话流。要做推送需要四件事：

1. Gateway 新表 `push_devices(account_id, device_token, platform, updated_at)`，加 `PUT /me/push-device`、`DELETE /me/push-device`。
2. 席位 bot 在 `turn/end`、审批进入等待、交接到达时，调 Gateway 的席位→Gateway 内部接口（[routes/internal.ts](../gateway/src/routes/internal.ts) 那一类，凭 `smt_`）报一条「谁的哪个 Bot 要人看」。
3. Gateway 直接调 APNs（iOS）/ FCM（Android）发出去（原定经 Expo push service，不用 Expo 之后就是直连两家）。
4. 手机壳用原生那几十行（Swift 的 `registerForRemoteNotifications` / Kotlin 的 FCM）拿设备 token，经 Tauri 命令交给页面注册到第 1 条；前台时不弹，后台时弹并带 `botId` 深链到对话。

这四件事都是独立 PR，不阻塞前两阶段。

## 3. 逐项去向

| 文件 | 动不动 | 怎么动 |
|---|---|---|
| gateway/ui/index.html | 动 | 加一行 `<script src="/core.js">` |
| gateway/ui/i18n.js | 动 | 字典正文搬到 core；这里只剩 `window.SATU_I18N = SatuCore.i18n`（或整文件删掉，由 core.js 挂） |
| gateway/ui/prefs.js | 动 | `t` / `errText` 转接；其余不动 |
| gateway/ui/state.js | 动 | 纯函数转接；`token()` 那段改成 `SatuCore.tokens`（Web 实现）；`state` 不动 |
| gateway/ui/data.js | 动 | `api` / `swFetch` / `localRoute` / `registerLocalBot` 转接；`load*` 不动 |
| gateway/ui/chat.js | 动 | 事件层和开流转接到 core；paint* 不动 |
| gateway/ui/markdown.js | 动 | 解析半边转接到 `SatuCore.createMarkdown`，DOM 半边原样 |
| gateway/ui/core.js | 新 | 打包产物，提交 |
| gateway/scripts/build-core.mjs | 新 | esbuild IIFE |
| gateway/src/http.ts | 动 | `ROOT_FILES` 加 `core.js` |
| e2e/ui-dom.mjs | 动 | 先加载 core.js，再拼 app 源码 |
| desktop/ | 不动 | `prepare-ui` 拷目录自然带上 core.js；但 core.js 变了桌面端就要发版，和改任何 UI 文件一样 |
| .github/workflows/check.yml | 动 | 加 core 单测、加「产物不漂」检查、加 mobile 的 `tsc` |
| pnpm-workspace.yaml | 动 | 加 `core`、`mobile` |
| core/ | 新 | 见 §4 |
| mobile/ | 新 | 见 §4 |

## 4. 目录与包

```
core/
  package.json          @satuwork/core，type module，exports 直接指 ./src/index.ts（没有 dist：
                        Web 由 esbuild 打包，mobile 由 Metro 打包，两边都吃得下 TS 源码）
  tsconfig.json         erasableSyntaxOnly：Node 24 直接跑 .ts 做单测，不能用 enum / 参数属性
  src/
    protocol/
      events.ts         SessionEvent 信封、折出来的块（UserBlock / AssistantBlock / MarkBlock / Folded）、RosterSum、PendingMessage、ChatPage
      runtime.ts        /runtime/bots 的 bot 行、runtime、session、history 响应
    api.ts              createApi()：gatewayAbs、swFetch、api()、401 分治
    local-route.ts      localBots / localSessions / localRoute
    requests.ts         getMe、listRuntimeBots、getBotSession、getHistory、postMessage、abort、approvals、handoffs、todos
    tokens.ts           TokenStore 接口（实现在宿主）
    i18n/
      dict.ts           原 i18n.js 的字典
      t.ts              t()、errText()、locale 读写注入
    format.ts           原 state.js 的纯函数（esc、时区、金额；usd 的语言由调用方传入）
    paths.ts            原 state.js 里从地址取 id 的那几个
    markdown/render.ts  createMarkdown({ t })：healStream、splitBlocks、render、safeUrl、esc、loadedImages
    chat/
      events.ts         messageText 等读法、splitUploads、isShot、maxSeqOf、insertEvent、cursorOf
      fold.ts           fold（原样）
      roster.ts         newSum、settleDot、applyRosterEvent、refreshSum
      pending.ts        mergePending
      pages.ts          mergeChatPage
      sse.ts            sseEvents
      backoff.ts        CHAT_RETRY_MAX / CHAT_ALIVE_MS / CHAT_IDLE_RETRY_MS / ROSTER_BACKOFF、chatRetryDelay、rosterRetryDelay、aliveLongEnough、classifyStreamStatus
      stream.ts         runEventStream（移动端的对话流循环；Web 的循环留在 chat.js，见 §5 第 3 步）
    index.ts
  test/                 node:test：fold、sseEvents、localRoute、api 的 401 两支、mergePending

mobile/                 Tauri 2 mobile 的壳，结构照 desktop/
  package.json          satuwork-mobile：dev:ios / build:ios / prepare:ui / icon
  README.md
  scripts/prepare-ui.mjs  把 gateway/ui 拷进 src-tauri/ui/（frontendDist，打进包）
  src-tauri/
    Cargo.toml          [lib] staticlib + cdylib（手机上 Tauri 把应用编成库）
    tauri.conf.json     identifier sg.dami.satuwork.mobile；windows 为空，窗口在 lib.rs 里建
    src/lib.rs          serve_ui（satu://）、LINK_SCRIPT 注入、导航守卫、allow_seat_desktop
    capabilities/       主窗口只放一条命令
    gen/apple/          tauri ios init 生成的 Xcode 工程，进版本库（Info.plist 的 ATS 在这儿）
    icons/              tauri icon 从 gateway/ui/assets/satuwork-logo.svg 生成
```

手机壳**不依赖** `@satuwork/core` 的源码——它装的是 gateway/ui，core.js 已经在里面。

Web 和 mobile 各自只依赖 `@satuwork/core`，不互相依赖。core 不依赖 React。

## 5. 上线顺序

每一步一个 PR，base 是 develop。**每一步 gateway/ui 的行为都不变**，整套 e2e 全绿是合入条件。

1. **脚手架**（已落地）：建 core 包、build-core、core.js 进 index.html / http.ts / e2e 垫片 / check.yml。只搬 i18n 字典和 state.js 的纯函数。目的是把四条消费路径（`pnpm dev`、`vercel-build`、桌面 `prepare:ui`、e2e）一次打通。
   落地时的几个具体选择：core.js **不压缩**（要进 PR diff）、`charset: 'utf8'`（中文键不转义）；
   译表搬过去时 TS 查出一条重复键（`只读`），删了后面那条；`usd` 的千分位语言改成入参，
   state.js 里包一层传 `localeMode`；`tokens` 在 core 里叫 `fmtTokens`，给后面的 TokenStore 让名。
2. **请求层**（已落地）：搬 `api()` / `swFetch` / `localRoute` / `t()` / `errText()` 和 `TokenStore`；data.js、prefs.js 转接。
   落地形态：`createGatewayClient({ fetch, baseUrl, tokens, locale, onUnauthorized, renewLocalBot })`，
   data.js 开头一次装配、解构回原来的名字。`TokenStore` 只是接口，Web 的存取代码本来就是
   浏览器存储，留在 state.js。`t` / `errText` 的语言成了第一个入参，prefs.js 包一层传 `localeMode`。
3. **事件层**（已落地，有一处偏离）：搬 `sseEvents` / `fold` / `mergePending` / `chatCursor` / 退避表，补单测。
   `fold` 一字不改地搬（只加类型），e2e 的 chat-fold 与 ui-smoke 继续经 Web 那层喂它。名单摘要
   （`settleDot` / `applyRosterEvent` / `refreshSum`）、桶的插入去重（`insertEvent`）、翻页合并
   （`mergeChatPage`）、本地回显（`mergePending`）都改成「返回 changed / left，由宿主决定画不画、
   写不写 state」的形态。
   **偏离**：chat.js 的 `startChatStream` **没有**改成薄壳。它那 340 行和重放闸、脉搏看门狗、
   `runtime/hello` 换进程、整页重绘缠在一起，改写的收益只有「移动端能复用」，而风险是整条对话流。
   所以 core 另给了一条给移动端的 `runEventStream`，和 Web 共用的是分帧（`sseEvents`）、状态码
   分治（`classifyStreamStatus`）、退避（`chatRetryDelay` / `aliveLongEnough` / `CHAT_RETRY_MAX`）
   ——规则改一处两边一起变，循环本身各走各的。名单流同理，`rosterRetryDelay` 共用，循环不动。
   另一个教训：chat.js 里的转接要写成**函数声明**而不是 `const x = SatuCore.x`——chat-fold.mjs
   把文件装进 vm 上下文按属性读名字，顶层 const 不挂到全局对象上。
4. **Markdown**（已落地）：能拆。原文件第 28–739 行整段搬到 `core/src/markdown/render.ts`，包在
   `createMarkdown({ t })` 里（`t` 是「复制」「下载」这几个按钮的文案；`loadedImages` 那张表由
   core 持有、DOM 半边往里加）。Web 的 markdown.js 只剩 DOM 半边加一行装配；e2e 的 markdown.mjs
   加载器先装 core.js。手机端可以拿 healStream / splitBlocks 喂自己的渲染器，也可以拿 render 的
   HTML 喂 react-native-render-html——`data-md` 标记都在。
5. **手机壳（iOS）**：`mobile/` 的 Tauri 2 工程——serve_ui、注入、导航守卫、iOS 工程、
   图标；state.js 加 `appShell()`。合入条件：模拟器里登录、名单、对话流跑通。
   （Expo 版的第 5 步做过、**已回滚**：#325 合进 develop 后当日决定不用 Expo，用 revert 撤回。）
6. **手机适配**（已落地）：index.html 的 viewport 加 `viewport-fit=cover`，app.css 末尾按 ≤760px
   那一档把安全区让出来（外壳、抽屉、登录屏、弹窗蒙版；浏览器里 env() 都是 0，等于没写）；
   shell.js 的 `startMobileShellFit` 在软键盘弹起时把可视视口高度写进 `--satu-vvh`、外壳跟着缩、
   页面钉回顶上（**只在手机壳里跑**，登录那种普通可滚页面不钉——钉了口令框会藏在键盘底下）；
   `deskEmbeddable` 在手机壳里一律 false，右栏退回「打开桌面」那颗按钮交给系统浏览器；个人设置
   里桌面端那块换成「在浏览器里打开」（同源 `_blank`，壳子换成 Gateway 的源）。
   窄屏抽屉、右栏盖在对话上、表格卡片化这些**本来就有**（≤760px 那一档），没动。
   （Expo 版的第 6 步**未合并即关闭**：#326。）
7. **推送**：§2.5 的四件事。
8. **发布**：`tauri ios build` 出 IPA，CI 上签名、传 TestFlight（照 desktop-release.yml 的做法，
   证书和 App Store Connect 密钥已经在 secret 里）；Android 之后再开（`tauri android init`）。

步骤 1–4 是 Web 侧的，步骤 5–8 是手机侧的；5 依赖 3，其余各步之间可以并行。

## 6. 不变量（改完之后仍然要成立的）

- gateway/ui 仍是无构建、普通脚本、同一个全局作用域；`core.js` 和 `blob-client.js` 是仅有的两个打包产物。
- gateway/ui 里的函数名和调用点不变，e2e 的 ui-dom / ui-smoke 断言不变。
- CSP 不变；没有内联脚本。
- 桌面端一个文件不改。
- `core` 里没有 `window` / `document`；所有网络请求都走注入的 fetch。core 的单测在 node 里跑。
- Gateway 接口不为移动端开新形状，除 §2.5 推送那几条。
- 对话流仍然只直连机器；手机不绕回 Gateway。

## 7. 明知的风险

- ~~markdown.js 可能拆不开~~ 已验证能拆（第 4 步）。手机端渲染器的选择留到第 5 步。
- **`fold` 搬动改行为。** 它有 Telegram 来源、渠道标签、模型切换、状态这些细节，而且只有 e2e chat-fold.mjs 一道兜底。搬之前先给它补 node 单测，用真实事件日志当夹具。
- **直连约束。** 「手机上能用」取决于机器的 `directUrl` 公网可达。本地开发那台 `192.168.64.1` 只在同一 Wi-Fi 下可用。
- **产物 diff 噪音。** 每个改 core 的 PR 带一份压缩后的 core.js。接受。
- **桌面端跟 UI 走。** core.js 一变，桌面端就要发版，和今天改 chat.js 一样。
- **前置账号。** Apple Developer（已有，桌面端在用）、FCM 项目是手机侧的前置条件，代码之外。
- ~~双份 Markdown 渲染~~ 手机装的是同一份界面，没有这个问题了。
- **两份壳代码。** serve_ui、CSP、导航守卫在 desktop/ 和 mobile/ 各一份，改一处要记得另一处。

## 8. 明确不做的事

- 不把 gateway/ui 改成 React / Vite / 任何需要构建的形态。
- 不用 react-native-web 做 Web 端；不用 Expo / React Native 做手机端。
- 不在手机上做本地 Bot；管理页不按手机调（能用就行，产品只承诺对话）。
- 不在 Gateway 上恢复对话流反代来「迁就」手机。
