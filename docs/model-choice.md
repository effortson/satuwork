# 日常模型：一个默认，几个备选，按会话挑

平台给一个**默认的日常模型**（`PlatformSettings.daily`）和最多 8 个**备选**
（`PlatformSettings.dailyAlternates`）。成员在对话框里给自己和某颗 Bot 的那条会话挑一个，
随时能换；Telegram 这类渠道里发 `/model` 也能换。

## 1. 名单在平台，选择在会话

- **名单**：模型配置页「日常模型备选」那一块，平台管理员维护。每个备选带自己的推理强度。
  写端逐个过 `companyModelAllowed`（供应商在注册表里、模型在 `enabledModels` 里）——
  这份名单就是人在对话框里能换到的全部，放一个白名单外的进来等于借「备选」绕过白名单。
  和默认相同的、重复的由 `parseDailyAlternates` 剔掉（读写两头同一份），所以「设为日常」
  之后同一个模型不会在对话框里出现两行。「设为默认」是对调，原来的默认降成备选时**不过
  上架规矩**——它当默认的时候从没被要求在 `enabledModels` 里。
- **事后收口**：目录会自己变——改自定义供应商的模型清单、删供应商、自动发现刷新或按下
  某个模型、收窄 `enabledModels`。这些地方改完都过一遍 `lib/alternates.ts` 的
  `pruneDailyAlternates`，上不了架的备选当场拿掉（响应和审计里带 `droppedAlternates`）。
  只被备选用着的供应商，删的时候同样要 `force=1` 确认一次（`clearedRoles` 里记 `日常备选`）。
- **界面只在真改了备选时才发 `dailyAlternates`**：服务端对收到的每个备选都重新过一遍规矩，
  每次存角色都捎上的话，名单里只要有一个后来下架了的，改日常 / utility 就全都 400。
- **下发**：`GET /runtime/catalog` 的 `models.dailyAlternates`，并且进 `modelStamp`——
  不进指纹的话，管理员下架一个备选，席位永远不重拉目录。
- **选择**：落在席位的会话日志上，一条 `session/model { key, label, by }` 事件。
  一个 Bot 在一个席位上只有一条会话（`ensureSession`），席位是人的，所以这就是
  「这个人 × 这颗 Bot」的选择。Web 和 Telegram 写同一条会话，两边看到的是同一个选择。
  `/new` 不清它——那是上下文边界，不是「恢复默认设置」。

为什么不存在 Gateway：桌面端的本地 Bot 根本不经过 Gateway；而席位才是真正按它跑的那一方，
选择放在它手上，就不会出现「界面上显示 A、实际跑的是 B」。

## 2. 席位怎么用它

`AgentService.homeModelOf`：**这条会话挑过的（还在名单里）→ Bot 自己那一对**（Gateway
下发时已钉成平台默认）。原来所有「Bot 自己那一对」的地方都换成了它：

- 每一轮开跑（`runTurn`）；
- 上下文压缩的窗口和写摘要的模型（手动 `/compact` 和轮末自动压缩同一个口径）；
- 委派子任务选 `model_role: daily` 时（「跟主代理同一个」）；
- 定时任务选 `daily` 时（「和聊天时一样」，docs/routines.md §4）。utility 那一档不受影响。

推理强度按选中那一项自己的 `reasoningEffort`（`roleReasoningEffort` 先认 daily、再认备选）。

**跑着的时候也能换**：那一轮的模型开跑时就定了，换不了；挑选从下一轮起生效，接口回
`nextTurn: true`，界面照着说「这一轮跑完后换成 xx」。排队的消息开跑时读的是最新的挑选。

**选的那个被下架了**：下一轮开跑前席位补一条 `session/model { key: null, reason: 'removed',
from }`，退回默认；界面画一句「xx 已不在可选名单里，改用默认模型 yy」。只在真开跑一轮时
补，读状态的接口不写日志。**目录还没拉到时不判下架**——那时备选名单是空的，照它判的话，
席位每次重启后的头一轮都会把人选好的模型退回默认。

## 3. 接口

席位（`bot/src/web/index.ts`）：

```
GET /api/sessions/:id/model  → { picked, effective, options: [{ key, provider, model, label, isDefault, contextWindow?, reasoning? }], removed }
PUT /api/sessions/:id/model  { key: 'provider/model' | null } 或 { arg: '2' | 'default' | 模型 id | 显示名 }
                             → 上面那些 + { changed, nextTurn }
                               400 { error }（不在名单里，原话列出能选的）
                               404 { error }（没有这条会话）
```

**只收 key，不收 provider + model 两个字段。** 理由和 `/messages` 只收角色名一样：这条路
浏览器也走得通，收一对任意的值就是给白名单开后门。

Gateway（`routes/runtime.ts`）：`GET|PUT /runtime/sessions/:id/model`，`proxyJson` 直转，
PUT 只转 `key`。桌面端本地 Bot 由 `data.js` 的 `localRoute` 按形状改道到 127.0.0.1。

## 4. 界面

- **选择器**：输入框那一行、附件按钮右边的一颗药丸，浮层往上开。只有默认一个、也没挑过
  时不画。状态以席位为准：看到新的 `session/model` 事件就重取一次
  （Telegram 那边换了，这边当场跟着变）。
- **`/model`**：唯一一条收参数的斜杠命令。不带参数打开选择器；`/model 2`、`/model default`、
  `/model <key|模型 id|显示名>` 直接换。参数原样作为 `arg` 交给席位，由 `pickModelArg`
  认——和 Telegram 是同一份规则。认不出来**不猜最接近的**，把能选的列在错里。
- **老席位**：GET 回 404 时选择器不画，但只是五分钟后再问一次，不是永远不问——席位可能在
  人开着页面时升级。
- **分割线**：`session/model` 在消息流里画成一条「从这里起用 xx」的线，翻历史知道哪一段是
  哪个模型写的。
- **Telegram**：`/model` 列出编号清单，`/model 2` 换。命令菜单（`setMyCommands`）长轮询
  模式下 Gateway 每次启动后的第一次拉取会重发；webhook 模式只在绑定和「重新连接」时发，
  老绑定要点一次重新连接菜单里才看得到它——直接打 `/model` 照样能用。

## 5. 发版顺序

Gateway 先上：老席位不认 `dailyAlternates`，照旧按默认跑；对话框问 `/model` 拿到 404，
选择器不画。再推 `bot-v*`；桌面端跟着发版（界面打在包里，本地 Bot 跟桌面端走）。
