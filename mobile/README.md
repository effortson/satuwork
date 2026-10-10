# satuwork-mobile

手机端（Expo + Expo Router）。**只做对话**：登录、Bot 名单、对话、设置。管理页面在手机上走浏览器。
来龙去脉见 [docs/adr-core-package-mobile.md](../docs/adr-core-package-mobile.md) §2.3–2.5。

逻辑层来自 [`@satuwork/core`](../core)：请求（`createGatewayClient`）、事件折叠（`fold`）、对话流
（`runEventStream`）、译表（`t`）都是和 Web 共用的同一份；这里只有屏幕和 React 状态。

```bash
pnpm install                                  # 仓库根目录
pnpm --filter satuwork-mobile start           # 开发服务器；按 i 开 iOS 模拟器里的 Expo Go
pnpm --filter satuwork-mobile typecheck
```

第一次启动在「设置」里填 Gateway 地址（模拟器里连本机用 `http://127.0.0.1:<port>`），再登录。

开发期可以预填登录屏（只在开发包里生效）：

```bash
EXPO_PUBLIC_DEV_EMAIL=admin@acme.test EXPO_PUBLIC_DEV_PASSWORD=… pnpm --filter satuwork-mobile start
```

模拟器里 Expo Go 下载卡住时，把缓存里的装进去再开地址：
`xcrun simctl install booted ~/.expo/ios-simulator-app-cache/Expo-Go-<ver>.tar.app && xcrun simctl openurl booted exp://127.0.0.1:8081`。

## 硬约束

- **对话流只直连席位机器**（Gateway 上没有反代）。机器的 `directUrl` 是内网地址时，手机不在同一
  网段就连不上；名单里 `runtime.streamUrl` 为空的 Bot 会灰掉并写明原因。
- 桌面端里的本地 Bot（127.0.0.1）手机上不可用。

## 目录

```
src/app/            Expo Router 路由：_layout（登录门）、login、bots、chat/[botId]、settings
src/gateway.ts      把 core 的客户端装配成手机那一套：expo/fetch、SecureStore 里的票与地址
src/store.tsx       React 登录态
src/chat/useChat.ts 取会话 → 拉历史 → runEventStream → fold
src/components/     气泡列表
```
