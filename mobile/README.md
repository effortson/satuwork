# satuwork-mobile

手机壳（Tauri 2 mobile）。**和桌面壳是同一个思路**：`gateway/ui` 那批分片原样打进包
（`pnpm prepare:ui`），由壳子自注册的 `satu://` 协议发出来（lib.rs 的 `serve_ui`），壳子把
Gateway 地址注入给页面（`window.__SATUWORK_GATEWAY__`），页面里所有打 Gateway 的请求在
`gateway/ui/data.js` 的 `swFetch` 那一层接上这个前缀。页面源是 `satu://localhost`
（Android 上是 `http://satu.localhost`），Gateway、席位机器的管家、本地 Bot 的守卫三处的
CORS 白名单早就认它——那是桌面端铺的路。

桌面壳里的本地 Bot、运行时下载、自升级、菜单、设置屏在手机上都没有。壳子只做三件事：
发界面、注入、把往外走的导航交给系统浏览器。为什么是 Tauri 而不是 Expo，见
[docs/adr-core-package-mobile.md](../docs/adr-core-package-mobile.md) §2.3。

## 跑（iOS 模拟器）

前置：Xcode、CocoaPods、Rust 的 iOS 目标（`rustup target add aarch64-apple-ios aarch64-apple-ios-sim`）。

```bash
echo http://127.0.0.1:3080 > mobile/src-tauri/dev-server.txt
```

```bash
pnpm --filter satuwork-mobile dev:ios "iPhone 17"
```

**连哪台 Gateway**：手机上没有设置屏也没有菜单，正式包固定连 `https://satuwork.com`；debug
构建读 `mobile/src-tauri/dev-server.txt`（不进版本库，本机各写各的），没有这个文件再看编译期
的 `SATUWORK_SERVER`。模拟器里的进程就是本机进程，`127.0.0.1:3080` 直达本机 Gateway，席位
机器的 `192.168.64.1` 也通；改了文件重开应用就生效。不用环境变量是实测出来的：`tauri ios dev`
经 Xcode 起 cargo，shell 里的变量传不进去，烤进包里的还是 satuwork.com。

debug 构建不用 `prepare:ui`：壳子直接读仓库里的 `gateway/ui`（模拟器读得到本机文件），改
界面重开应用就见；只有打包才拷。

**Xcode 27 下 `tauri ios dev` 编译、装包都过，最后一步起应用会失败**（它对模拟器也走
`devicectl`，报 CoreDeviceError 10002）。包已经在 DerivedData 里，自己起一下：

```bash
xcrun simctl launch booted sg.dami.satuwork.mobile
```

装没装上用 `xcrun simctl install booted <DerivedData 里的 Satuwork.app>`。

debug 构建还会把页面的 `console.error` / `console.warn` / 未捕获异常抄到应用容器的
`tmp/satuwork-mobile.log`（lib.rs 的 DEBUG_SCRIPT；正式包不注入）。容器路径：

```bash
xcrun simctl get_app_container booted sg.dami.satuwork.mobile data
```

`--no-dev-server`（已写在 `dev:ios` 里）：Tauri 默认会起一个静态文件服务器、把页面源换成
`http://<本机 IP>:1430`，那个源 Gateway 的 CORS 不认。界面由 `satu://` 发，不需要它。

明文 http 的 Gateway 要过 iOS 的 ATS：Info.plist 里放了 `NSAllowsLocalNetworking`
（`gen/apple/satuwork-mobile_iOS/Info.plist`），本机和内网地址都过，公网明文不过——正式包
连的是 https，不用放 `NSAllowsArbitraryLoads`。

## 出包

```bash
pnpm --filter satuwork-mobile build:ios
```

签名、TestFlight 走 CI（ADR §5 第 8 步，还没接）。`gen/apple/` 是 `tauri ios init` 生成的
Xcode 工程，**进版本库**：开发团队、ATS、能力声明都改在里面；重新 `tauri ios init` 会把它
盖掉，改完要回看一遍 diff。

## 和桌面壳共用的代码

`serve_ui`、UI_CSP、导航守卫（`allow_navigation` / `is_seat_desktop` / `open_path_allowed`）
是从 desktop/src-tauri/src/main.rs 抄过来的，**两边要一起改**。差别只有一处：同源的
`target="_blank"`（「打开桌面」）桌面上另开一扇应用窗口，手机只有一扇窗，换成 Gateway 的
源交给 Safari——Gateway 发的是同一份界面，在 Safari 里登录一次就能看（`open_target`）。

## 还没做的事

- 安全区（刘海、Home 条）、软键盘顶起输入框——ADR §5 第 6 步。
- 推送——§2.5；Tauri 官方 notification 插件只做本地通知，远程推送要几十行 Swift。
- Android：`tauri android init`；代码已经不依赖 iOS，差的是工程和 CI。
- 票换 stronghold / Keychain：现在和桌面壳一样落 localStorage，iOS 的应用容器本身静态加密。
