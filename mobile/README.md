# satuwork-mobile

手机壳（Tauri 2 mobile）。**和桌面壳是同一个思路**：`gateway/ui` 那批分片原样打进包
（`pnpm prepare:ui`），由壳子自注册的 `satu://` 协议发出来（lib.rs 的 `serve_ui`），壳子把
Gateway 地址注入给页面（`window.__SATUWORK_GATEWAY__`），页面里所有打 Gateway 的请求在
`gateway/ui/data.js` 的 `swFetch` 那一层接上这个前缀。页面源是 `satu://localhost`
（Android 上是 `http://satu.localhost`），Gateway、席位机器的管家、本地 Bot 的守卫三处的
CORS 白名单早就认它——那是桌面端铺的路。

桌面壳里的本地 Bot、运行时下载、自升级、菜单、设置屏在手机上都没有。壳子负责
发界面、注入、保存服务器地址、把往外走的导航交给系统浏览器。为什么是 Tauri 而不是 Expo，见
[docs/adr-core-package-mobile.md](../docs/adr-core-package-mobile.md) §2.3。

## 跑（iOS 模拟器）

前置：Xcode、CocoaPods、Rust 的 iOS 目标（`rustup target add aarch64-apple-ios aarch64-apple-ios-sim`）。

```bash
echo http://127.0.0.1:3080 > mobile/src-tauri/dev-server.txt
```

```bash
pnpm --filter satuwork-mobile dev:ios "iPhone 17"
```

**连哪台 Gateway**：登录页右上角显示当前服务器，点开后可以填地址、「检测」、
「检测并使用」或「恢复默认」。只有 `/health` 成功且返回 `{"ok":true}` 才会保存到应用配置目录
的 `server.txt`，随后在同一个窗口重新加载登录页，清掉旧登录票；重启应用也会记住选过的服务器。
不写协议按 `http://` 处理，默认是 `https://satuwork.com`。

没存过地址时，debug 构建读 `mobile/src-tauri/dev-server.txt`（不进版本库，本机各写各的），
没有这个文件再看编译期的 `SATUWORK_SERVER`；正式包忽略这两项，使用默认服务器。
模拟器里的进程就是本机进程，`127.0.0.1:3080` 直达本机 Gateway，席位
机器的 `192.168.64.1` 也通；尚未手动选择服务器时，改了文件重开应用就生效。不用环境变量是实测出来的：`tauri ios dev`
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
默认连的是 https，不用放 `NSAllowsArbitraryLoads`。手动切换公网服务器时也应使用 https。

## 跑（iOS 真机）

iPhone 用 USB 连接 Mac 并信任这台电脑，在「设置 → 隐私与安全性 → 开发者模式」开启后按提示重启。
`xcrun devicectl list devices` 应能列出已配对的真机。Mac 和 iPhone 要在同一局域网；Gateway 地址用
Mac 的局域网 IP，不能用 `127.0.0.1`，席位机器的 `directUrl` 也必须是 iPhone 能访问的地址。

```bash
echo 'http://192.168.1.100:3080' > mobile/src-tauri/dev-server.txt # 替换为 Mac 的局域网 IP
touch mobile/src-tauri/build.rs # 首次创建 dev-server.txt 时，确保重新读取并打进包
pnpm --filter satuwork-mobile prepare:ui
pnpm --filter satuwork-mobile dev:ios "<devicectl 列出的 iPhone 名称>"
```

真机读不到 Mac 上的仓库：界面和 Gateway 地址都要在构建时打进去，修改后需要重新拷界面、编译并安装。
模拟器那套「改文件后重开应用」不适用于真机。签名描述文件必须包含这台设备的 UDID。

真推送还要在本机 `gateway/.env` 配齐 `GATEWAY_APNS_*`，然后重启 Gateway；密钥来自 Apple Developer
的「Certificates, Identifiers & Profiles → Keys」，必须启用 APNs，不能使用 App Store Connect API / 公证密钥。
本机开发签名的设备令牌属于 sandbox，密钥的环境和 topic 要覆盖它。登录时允许通知后，`push_devices` 应出现
`platform=ios, environment=sandbox` 的登记。密钥和 `.env` 不进版本库。

测试通知要同时更新正在运行的席位 Bot：当前 `/internal/push` 要求 `sessionId` 和稳定的事件 `seq`，
旧运行时只报 `kind` / `botId` 会被拒绝。验证时检查回复完成后的 `notification_events` 与按设备的
`notification_deliveries`，再核对手机实收、点通知跳转、前台已读抑制和应用终止后的冷启动。

## 跑（Android 模拟器）

前置：JDK 17、Android SDK（platform 36、build-tools、platform-tools、emulator、arm64 系统镜像）、
NDK、Rust 的 Android 目标。没装 Android Studio 也行，命令行工具 `sdkmanager` / `avdmanager` 就够。

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 17) ANDROID_HOME=~/Library/Android/sdk NDK_HOME=~/Library/Android/sdk/ndk/29.0.14206865
```

```bash
adb reverse tcp:3080 tcp:3080
```

```bash
pnpm --filter satuwork-mobile dev:android satuwork-36
```

- **设备名用 AVD 名**（`emulator -list-avds` 列出来的），不是 `adb devices` 里的 `emulator-5554`：
  后者认不出，它会退回去打开 Android Studio，没装的话就停在那儿还拿着构建锁。
- **Gateway 地址**：Android 模拟器是一台虚拟机，读不到本机的 `dev-server.txt`，由 build.rs 在构建时
  烤进去；改了文件要重编。**头一回新建**这个文件时 cargo 察觉不到（build.rs 只在文件存在时才盯它，
  免得没有它的 checkout 每次都重编），先 `touch mobile/src-tauri/build.rs` 再编。模拟器里的 127.0.0.1
  是它自己，要先 `adb reverse` 把端口转回本机。
- **界面**：同理读不到仓库里的 `gateway/ui`，debug 构建也走包里那份——先 `pnpm prepare:ui`，
  改了界面要重拷、重编。
- debug 构建把导航和页面报错打进 logcat（标签 `RustStdoutStderr`，前缀 `[satuwork]`）：

```bash
adb logcat | grep "\[satuwork\]"
```

两处 Android 特有的处理，都在原生层：

- **键盘和系统栏**：Android 15（targetSdk 35+）起应用强制全屏、窗口不再随键盘缩短，登录按钮和
  对话输入框会压在键盘底下。`gen/android/.../MainActivity.kt` 按系统栏、刘海、键盘的 inset 给内容
  视图加内边距，WebView 跟着变矮；让出来的那一圈用页面底色（`res/values*/colors.xml`）。
- **外链**：导航回调在 Android 上跑在界面线程，在那儿同步调 opener 插件会卡住、浏览器起不来。
  lib.rs 的 `open_external` 另起线程调。

推送走 FCM：插件的 Kotlin 那半在 `push-plugin/android/`。它要 `google-services.json`（Firebase 项目
`satuwork-993fa`）放在 `src-tauri/gen/android/app/`——**仓库是公开的，这个文件不进版本库**（那一层的
.gitignore 挡着）。没有它也编得过，只是不套 google-services 插件，`register` 回「没配 Firebase」，
页面不登记。本机从 Firebase 控制台下载一份放进去；以后出 Android 正式包的 CI 从 secret 写进来。

Gateway 还需要在本机 `gateway/.env` 配 `GATEWAY_FCM_SERVICE_ACCOUNT`：同一 Firebase 项目的服务账号
私钥 JSON 全文或整段 base64。配置文件和私钥都不进版本库。重启 Gateway、重编 Android 包后，登录时
允许通知，手机会把 FCM 令牌登记到 `/me/push-device`。Android 8+ 使用「Bot 消息提醒」频道，后台显示
通知，点开跳到对应 Bot 的对话；前台由聊天消息流更新，不额外弹通知。
Bot 的回复完成与待审批事件正常上报推送，不按 SSE 连接数或回复耗时过滤；手机在后台或管家汇总
名单时流仍可能连接，不能拿它判断用户是否正在阅读。

真机锁屏后通知延迟时，也要检查应用的电池限制。三星 One UI 可在「设置 → 应用程序 → Satuwork →
电池 / 后台运行」选择「不受限制」；「受限制」或「深度休眠」会限制后台活动、自动运行。
Android 客户端在登录和回到前台时检查标准后台限制与电池优化状态。需要调整时显示可暂时关闭的提醒，
「打开应用设置」进入当前应用的系统详情页，再按提示进入电池 / 后台运行选择「不受限制」。
个人设置页始终保留检测结果、重新检测和设置入口；设置完成返回应用后自动复查。
不同厂商的自启动、休眠应用策略无法通过标准 API 完整判断，个人设置中的引导也会提醒检查这些选项。
排查时用 `adb shell cmd appops get sg.dami.satuwork.mobile RUN_ANY_IN_BACKGROUND` 核对：`ignore` 表示
后台运行被限制。调整应用自己的设置后，再保持熄屏、通过真实聊天验证送达时间和点击跳转。

模拟器里测点通知不需要 FCM 真发：系统在用户点开 FCM 通知时给应用的就是带这几个 extra 的 intent，
照样发一个即可（应用在后台时走 onNewIntent，强停后再发走冷启动）：

```bash
adb shell am start -n sg.dami.satuwork.mobile/.MainActivity --es google.message_id 0:1 --es botId <botId> --es kind turn-end
```

## 下载

页面里的「下载」（导出对话、存工作区文件、知识库文件、代码块和图）都是 `<a download href="blob:…">`
点一下。WebView 里这种点击什么都不发生：WKWebView 没挂下载处理就直接取消，Android 的 WebView 没有
DownloadListener。所以 lib.rs 的注入脚本拦下 `a[download]`，把 blob 读成字节交给
[share-plugin/](share-plugin/)：Rust 写进应用缓存目录，原生那半弹系统的分享面板（iOS 的「存储到文件」、
AirDrop，Android 的分享选择器）。http(s) 的下载链接交给系统浏览器。

壳子的 CSP 因此比桌面壳多一处：`connect-src` 认 `blob:` / `data:`，不然注入脚本读不到 blob。

## 出包

Android 桌面图标单独重新生成：`pnpm --filter satuwork-mobile icon --android`。
生成器会同步各密度 PNG 和普通 / 圆形自适应图标；前景每边留出 20%，避免启动器裁掉机器人外框和底座。
`pnpm --filter satuwork-mobile icon` 则重新生成所有平台的图标。

```bash
pnpm --filter satuwork-mobile build:ios
```

本机出的是自己签名的包。发 TestFlight 走 CI：打 `mobile-vX.Y.Z` 的 tag
（版本要等于 `src-tauri/tauri.conf.json` 的 version），[mobile-release.yml](../.github/workflows/mobile-release.yml)
在 Xcode 26 的 runner 上使用 Apple Distribution 证书和本 App 的 App Store 描述文件签名、出 IPA，
再用 App Store Connect API 密钥传 TestFlight。手动触发不填 tag 就只出 IPA artifact，不上传。
证书的加密 P12、口令和描述文件分别存到 GitHub Actions Secrets 的 `IOS_DISTRIBUTION_P12_BASE64`、
`IOS_DISTRIBUTION_P12_PASSWORD`、`IOS_PROVISIONING_PROFILE_BASE64`；上传仍用现有 `APPLE_API_*`。
前置检查会拒绝开发描述文件、其他 App 的描述文件和缺少 production APNs 权限的包。
签名材料只放在 runner 的临时目录和临时 keychain，任务结束后清理。正式推送配置和实收验收见
[Vercel 部署手册](../docs/vercel-deploy.md#testflight--app-store-的-apns)。

`gen/apple/` 是 `tauri ios init` 生成的 Xcode 工程，**进版本库**：开发团队、ATS、推送能力、出口
合规声明都改在里面；重新 `tauri ios init` 会把它盖掉，改完要回看一遍 diff。

**正式包从包里发界面**（release 下 `ui_dir()` 是 None，走 `asset_resolver`）。Tauri 的
`asset_resolver` 找不到文件会自己回落到 index.html，所以 lib.rs 先查文件在不在包里再取，
否则单页路由和缺的脚本会拿到 index.html 的字节、却标成别的 MIME。模拟器的 release 路不好走
（`tauri ios build` 要和 Xcode 配套的模拟器运行时），验正式包发界面可以在 Mac 上
`cargo build --release` 跑这份壳：发界面的代码是同一份。

## 和桌面壳共用的代码

`serve_ui`、UI_CSP、导航守卫（`allow_navigation` / `open_path_allowed`）是从
desktop/src-tauri/src/ 的 ui.rs / nav.rs 抄过来的，**两边要一起改**。手机上有意不同的几处：

- 同源的 `target="_blank"`（个人设置里的「在浏览器里打开」）桌面上另开一扇应用窗口，手机只有一扇窗，换成 Gateway 的
  源交给 Safari——Gateway 发的是同一份界面，在 Safari 里登录一次就能看（`open_target`）。
- 手机端不提供远程桌面预览或「打开桌面」入口，也不挂载 VNC。运行状态和日常任务仍然保留。
  没有桌面 iframe 的放行（桌面壳的 `allow_seat_desktop` / `is_seat_desktop`），那条命令和那座桥也就不开。
- `mailto:` / `tel:` / `sms:` 交给系统（`hand_to_system`）：WebView 自己打不开它们，放行等于点了没反应。
- CSP 的 `connect-src` 多认 `blob:` / `data:`，见上面「下载」。

## 推送

原生那一半在 [push-plugin/](push-plugin/)（Swift 在 `push-plugin/ios/Sources/SatuPushPlugin.swift`），
登记到 Gateway 在 gateway/ui/shell.js 的 `syncMobilePush`。三端共用 Gateway 上的阅读游标：
任意端实际读过后，尚未发送的提醒取消，未读角标同步；手机回到前台时会清理已经读过的系统通知。
这不会批准审批，也不会关闭转人工单。调度、离线恢复与系统限制见 [跨端通知](../docs/notifications.md)。

模拟器里测点通知，不需要 APNs 钥匙：

```bash
xcrun simctl push booted sg.dami.satuwork.mobile payload.apns
```

payload 照 Gateway 发的形状写：`{"aps":{"alert":{"title":"…","body":"…"}},"botId":"…","kind":"turn-end"}`。
应用在后台时点横幅，应该跳到那颗 Bot 的对话。点通知有三路会去取：页面启动完（冷启动）、回到前台、
原生那半记下之后叫页面一声（`__SATUWORK_PUSH_TAPPED__`）；取一次就清，撞在一起也只跳一次。

真推送要三样都齐：Gateway 配了 `GATEWAY_APNS_*`（docs/vercel-deploy.md）、App ID 开了 Push
Notifications 能力、手机上允许了通知。

令牌认哪一头由**签名**定，不由编译开关定：开发签名的包（debug 构建、本机 `build:ios` 出的 release 包）
拿的是 sandbox 令牌，App Store / TestFlight 的包是 production。iOS 那半读包里描述文件的
`aps-environment` 如实报给 Gateway（SatuPushPlugin.swift 的 `apsEnvironment`），报错了 APNs 回
BadDeviceToken，Gateway 会把令牌当作废摘掉。

## 还没做的事

- Android 正式包和 Play 上架：签名 keystore、AAB、CI 里写入 google-services.json。
- 票换 stronghold / Keychain：现在和桌面壳一样落 localStorage，iOS 的应用容器本身静态加密。
