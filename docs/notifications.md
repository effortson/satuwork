# 跨端已读和通知

Gateway 只保存通知元数据，不保存消息正文。未读计数沿用原先的提醒语义：一轮回复完成、一张
待审批卡或一张转人工单各算一项；流式分片不累计未读。阅读状态和审批 / 交接的处理状态独立。

## 阅读与同步

`notification_reads` 按账号、Bot、会话保存 `lastReadSeq` 和版本。客户端必须处于前台且窗口聚焦，
对应会话内容已渲染、进入可视区域后才能上报。位于消息流底部时推进到当前已展示的完整消息 / 事件；
向上翻历史只推进到可视行的序号。挂着 SSE、打开设置页、点击通知但还未载出正文均不算已读。

- `PUT /me/notifications/read { botId, sessionId, seq }`：只认本人登录 JWT，游标取较大值，旧设备和乱序
  请求不会使它倒退。允许阅读先于通知元数据抵达。
- `GET /me/notifications`：返回一致的游标、按 Bot 聚合的未读计数、近期可提醒事件、应清理的通知 ID。
  三端共用 `gateway/ui/notification-sync.js`，前台每秒、隐藏时每三秒短轮询；业务事件、聚焦和联网也会
  立即唤醒同步，不增加 Gateway 长连接。
- 离线已读和本地 Bot 待上报事件按 Gateway、账号隔离保存在本机。联网时先补交已读，再补交事件、获取
  快照和领取提醒。登出使进行中的旧请求失效；下个账号不会接收到旧账号的状态。

读取审批卡只清未读，不修改 `asks`；读取交接卡不修改 `openIds` / `snapIds`，也不批准操作、接手或关单。
真实审批和交接状态流转仍由原业务接口完成。终态会使相应的旧提醒失效，乱序的 pending 上报不能将它复活。

## 统一调度

`notification_events` 按账号、Bot、会话、序号、类型幂等登记。席位的 `/internal/push` 现在要求稳定会话
序号，返回 `202 { queued: true, id }`。审批终态携带原 pending 序号及 `resolved: true`；交接通知的序号由
`/internal/handoffs` 的 `notificationSeq` 传入。本地 Bot 使用登录端的 `/me/notifications/local` 上报。
本地 Bot 的提醒仍限定桌面端，不向无法打开本地会话的手机发送系统推送。

事件落库后缓冲两秒。网页和桌面收到原始 Bot 事件仅更新业务界面、唤醒同步；显示提醒之前必须调用
`POST /me/notifications/:id/claim { deviceId }`。设备标识以 `web:` / `desktop:` 开头，同一浏览器各标签共用，
同一事件只能领取一次。未到期、已读、已处理、过期或属于别的账号时不允许领取。

手机由 Gateway 按有效登记设备领取投递租约，再调用 APNs / FCM。投递前再次核对已读；成功和失败按设备
分别记录，失败退避后重试，成功设备不会因另一台失败而重发。新登记设备不补推登记前的积压提醒。

快速唤醒由 `afterResponse` 托管；持久队列是事实源，常驻进程每秒扫描，Vercel 的 `/cron/tick` 负责兜底。
进程终止不会丢队列；未完成投递的租约到期后可继续处理。每次扫描有时间预算，避免慢设备耗尽函数时间。
重试仍可能在“系统已接收、回执或数据库确认丢失”的网络边界重复，不能承诺系统通知严格恰好一次。

## 系统通知清理与边界

推送只带 Bot 名、固定事件说明和通知 / 会话 / 序号标识。Android 使用稳定通知 ID 作为系统通知 tag；iOS
按 payload 中的 ID 清理通知。在线同步时，以及手机恢复前台时，会尽力移除已读或已失效提醒。
桌面也请求系统撤回已读提醒；目前通知插件在 macOS / Windows 上不支持移除已展示通知，Linux 支持。
已经响过的声音无法撤销；设备离线、后台暂停或推送已经交给系统时，不能保证立即清理。

两秒缓冲通常足以让正在阅读的端提交已读；没有提交到服务端的离线阅读不能即时抑制其他设备。

## 发布与验证

先发布 Gateway（自动迁移 0069～0071），再更新席位 Bot / 管家，以及打包包含最新共用 UI 的桌面、手机端。
新协议要求稳定序号，旧席位的无序号上报会被拒绝，不能将混用旧通知代码的客户端视为已支持跨端去重。

验证入口：

- `node --test gateway/test/*.test.mjs`：三端 UI、可视阅读、离线恢复、并发快照和桌面桥回归。
- `E2E_ONLY=push,gateway-chat,roster-stream,handoff,serverless,ui-smoke,ui-files,migrate node e2e/run.mjs`：
  真 PostgreSQL / HTTP、真 Bot 上报、三份客户端、模拟 APNs / FCM、并发领取、失败重试和重启恢复。
- `pnpm typecheck`、`pnpm test:core`，以及桌面 / 手机 Cargo 测试、Android Kotlin 与 iOS Swift 编译。
