# 本地 Bot 只属于建它的那台电脑

本地 Bot（`runtimeKind = 'local'`）跑在 Satuwork Desktop 起的进程里，工作区、对话都在那台电脑的
`app_data_dir` 下，Gateway 连不到它。**它只在建它的那台电脑上存在**：别的电脑上的桌面端、网页、
App 都看不到它，也不会把它启动起来。

| Bot | 建它的那台桌面端 | 别的桌面端 | 网页 / App |
|---|---|---|---|
| 远程 Bot（席位） | 看得到 | 看得到 | 看得到 |
| 本地 Bot，已绑定设备 | 看得到 | **看不到** | **看不到** |
| 本地 Bot，老数据、还没绑定 | 看得到（本机有它的数据才自动认领，见 §4.3） | 看得到 | 看不到 |

**这不是安全边界。** 设备 ID 是客户端自己报的，桌面端那套 `sat_` 也还是按账号发的（迁移 0041）。
这里解决的是「看得到什么、谁来跑」，不是「谁有权限」——同一个账号的几台电脑本来就是同一个人。

---

## 1. 现状和要修的问题

本地 Bot 在库里是 `catalog_items` 的一行：`scope = 'user'`、`definition.runtimeKind = 'local'`，
只挂在账号上。于是：

1. **所有端都列出它。** `GET /runtime/bots` 走 `db.botsFor(companyId, accountId)`，只按账号过滤。
   网页上能看到一颗点不开的「本地」Bot。
2. **别的电脑会把它也起一份。** `ensureDesktopLocalBots`（`gateway/ui/chat.js`）对名册里每颗本地
   Bot 都 `local-bootstrap` → `start`。B 机上会开出一个同 id、工作区全空的进程，两台机器同时来领
   这颗 Bot 的派活。
3. **日常任务不分 Bot 就领（已有 bug）。** `/runtime/local-routines/due`（`routes/worker.ts`）只按
   账号查，不带 botId：账号下任何一颗本地 Bot 的进程都会领走别的本地 Bot 的任务，再往**自己**的
   HTTP 口发 `/api/bots/<别人的 id>/session`。`local-tasks` 早就按 botId 领了，routines 没跟上。
   多台电脑之后，B 机的进程还会领走 A 机那颗的任务。

## 2. 设备身份

### 2.1 壳子生成、壳子保存

Desktop 第一次启动时在 `app_data_dir` 下写 `device.json`：

```json
{ "id": "<uuid v4>", "createdAt": 1793000000000 }
```

- 和 `bot_paths()` 用同一个根目录：数据目录没了，这台电脑上本地 Bot 的工作区也没了，设备身份跟着
  换掉是对的——旧 id 名下的 Bot 本来就跑不回来了（见 §7）。
- 读不到、解析失败、格式不对（不匹配 `^[a-zA-Z0-9-]{16,100}$`）就重新生成并覆盖写。
- **不放 localStorage。** WebView 的存储可能被清（或换 profile），而 Bot 的数据还在；两边一旦
  对不上，用户会看着自己的本地 Bot 凭空消失。

### 2.2 交给页面

`desktop/src-tauri/src/nav.rs` 的注入脚本里，紧挨着 `__SATUWORK_DESKTOP__ = true` 加：

```js
window.__SATUWORK_DESKTOP_DEVICE__ = { id: '<device.json 的 id>', name: '<主机名>', platform: 'darwin' }
```

`name` 取系统主机名，只用于界面上「在哪台电脑上」那一行，不参与任何判断。

`gateway/ui/notification-sync.js` 的 `notificationDeviceId()` 在桌面端里**没存过**通知设备 id 时
改用这个 id（仍拼成 `desktop:<id>`）。已经存过的照旧用存的那个：投递按（事件, 设备）去重，升级后换个 id，
重放窗口里已经弹过的提醒会被当成新设备再弹一遍。网页照旧。

### 2.3 带进请求

- `core/src/api.ts` 的 `createGatewayClient` 加一个可选项 `deviceId?: () => string | null`。
  `swFetch` 打 Gateway 的请求带上 `x-satuwork-device: <id>`；**改道到 127.0.0.1 的那几条不带**
  （本地 Bot 不需要它）。
- `gateway/ui/data.js` 在桌面端里传 `() => window.__SATUWORK_DESKTOP_DEVICE__?.id ?? null`；
  网页和手机不传。
- 同一处再加一个 `client` 选项，带成 `x-satuwork-client: desktop | mobile`。**手机壳的页面源和桌面壳
  是同一个**（`satu://localhost`，见 `mobile/src-tauri/src/lib.rs`），只看 Origin 分不出两者；
  桌面源、却两个头都没带的，才是还没升上来的老桌面端（§4.1、§8）。网页同源，不带。
- `gateway/src/http.ts` 的 CORS `access-control-allow-headers` 加上这两个头（桌面端是跨源的，见那里的
  `CORS_ORIGINS`）。

## 3. 数据

新迁移（编号接当时最新的那一个）：

```sql
alter table catalog_items add column if not exists "deviceId" text;
create index if not exists catalog_items_device on catalog_items ("accountId", "deviceId")
  where "deviceId" is not null;

create table if not exists desktop_devices (
  id          text primary key,
  "accountId" text not null references accounts(id) on delete cascade,
  name        text not null default '',
  platform    text not null default '',
  "createdAt" bigint not null,
  "lastSeenAt" bigint not null
);
create index if not exists desktop_devices_account on desktop_devices ("accountId");

-- 「本地」分类的标记，见 §5
alter table bot_folders add column if not exists kind text;
create unique index if not exists bot_folders_local on bot_folders ("accountId") where kind = 'local';
```

- `deviceId` 用单独一列，**不放进 `definition`**：`definition` 会经 `publicBot` 原样发给前端，
  而且按设备查要走索引。
- `desktop_devices` 只用于展示（设备名、最后在线时间）和清理没人管的 Bot（§7），可见性判断不依赖它。
  `lastSeenAt` 在 `local-bootstrap` 和名册请求时顺手更新，最多一分钟写一回。
- 老的本地 Bot 的 `deviceId` 全是 null，不回填，由 §4.3 认领。

## 4. 可见性规则

### 4.1 这次请求是从哪来的

统一收进一个函数，返回这次请求的「视角」：

```ts
// gateway/src/db/types.ts
type BotViewer =
  | { kind: 'device'; id: string }   // 带了 x-satuwork-device 的桌面端
  | { kind: 'legacy-desktop' }       // 桌面源、两个头都没带的老壳子：只看得到还没绑定的（§8）
  | { kind: 'none' }                 // 网页、手机
  | { kind: 'seat' }                 // 席位票（sat_）的请求：Bot 进程，§4.4

// gateway/src/lib/guards.ts
function viewerOf(req: Req): BotViewer
```

- 票是 `sat_` → `seat`。
- 否则有合法的 `x-satuwork-device` → `device`；没有，`Origin` 在桌面源里（`satu://localhost` 等）、
  而且没带 `x-satuwork-client` → `legacy-desktop`；其余（网页、手机）→ `none`。

### 4.2 一条规则，收在 `botsFor` 里

```ts
// gateway/src/lib/catalog.ts
function botVisibleTo(item: CatalogItem, viewer: BotViewer): boolean {
  if (runtimeKindOf(item) !== 'local') return true
  if (viewer.kind === 'none') return false
  if (viewer.kind === 'device') return item.deviceId == null || item.deviceId === viewer.id
  if (viewer.kind === 'legacy-desktop') return item.deviceId == null
  return true   // seat；席位那一侧的派活名单另外收窄，见 §4.4
}
```

SQL 里判「是不是本地 Bot」一律写 `coalesce(definition->>'runtimeKind', '') = 'local'`：Telegram 绑定建的、
runtimeKind 出现之前建的用户 Bot 都没有这个键，不 coalesce 的话 `not (… = 'local')` 是 null，整行会被筛掉。

`db.botsFor(companyId, accountId)` 改成 **`botsFor(companyId, accountId, viewer)`，`viewer` 必填**。
按设备过滤这件事和「按主人过滤」一样，由这一个 where 来保证，不靠每个调用点各自记得。参数必填，
编译器会逼着每个调用点都想一遍自己算哪种视角。现有调用点：

| 调用点 | 用途 | 视角 |
|---|---|---|
| `routes/runtime.ts` `GET /runtime/bots` | 侧栏名册 | 请求的视角 |
| `routes/runtime.ts` `PUT /runtime/bots/:botId/folder` | 放进分类 | 请求的视角 |
| `routes/runtime.ts` `PUT /runtime/main-bot` | 设主 Bot | 请求的视角 |
| `routes/runtime.ts` `POST /runtime/tasks` | 主 Bot 派活 | 席位，§4.4 |
| `routes/runtime.ts` `POST /runtime/sessions/:id/messages` | 主 Bot 对话里的 @ 名单 | 请求的视角 |
| `routes/runtime.ts` `userBotOf` / Skill 增删那几条 | 按 id 操作自己的 Bot | 请求的视角 |
| `routes/runtime.ts` `GET /runtime/catalog`（及 `/version`）、`seatBotOf` | Bot 进程拉目录 | 席位，§4.4 |
| `routes/connectors.ts`（四处） | 连接器给哪些 Bot 用、@ 名单 | 请求的视角，见下 |
| `lib/runtime.ts` `visibleBotOf` | 会话、文件等按 id 取 Bot | 请求的视角 |
| `deploy/seat.ts` `reserveSeat` | 部署 | 本地 Bot 本来就不部署，传 `none` |
| `lib/usage.ts` | 用量页的 Bot 名字 | `seat`（不过滤），见下 |

- **按 id 直接访问的接口**（`ownBotOf`：改名、删除、记忆、日常任务等）同样过一遍 `botVisibleTo`，
  看不到就回 404「没有这个 Bot」——和「别人的 Bot」一个口径，不另外解释。
  **`local-bootstrap` 例外**：别的电脑上的本地 Bot 回 409「在另一台电脑上」（见 §4.3），网页、手机
  照旧 404。
- **用量页不过滤**：那是账单，钱是这个账号花的，少一行就对不上总数；名字照旧显示（公司那一档的用量
  本来就按公司全部 Bot 取名字）。
- **连接器的「可用 Bot」范围**：这台看不到的本地 Bot 不算 `missing`（它没被删）；保存范围时，原来勾着、
  这台看不到、但还在的那几颗**照旧留着**，不能因为 B 机交上来的名单里没有它，就替 A 机把它勾掉了。
  「读出原来的、合并、写回」放在一把锁里（`CONNECTOR_BOT_SCOPE_LOCK`，键是 连接:账号），两台同时保存也不会互相冲掉。
- **主 Bot**：设成了别的电脑上的本地 Bot 时，`GET /runtime/bots` 现有的「不在名单上就给 null」
  已经处理，界面不画皇冠。不用改。

### 4.3 老数据认领

`deviceId` 为 null 的本地 Bot，在 `device` 视角下暂时看得到，名册里带 `unclaimed: true`；**哪台电脑先把它
跑起来就归哪台**。桌面端**只在本机有它的数据时才自动起它**（壳子的 `local_bot_status` 回 `hasData`：数据目录里
有 Bot 进程写的 `satuwork.db`）——否则先升级的那台会把数据其实在另一台电脑上的老 Bot 全部领走。本机没有数据的，
对话页上写清楚「还没归到哪台电脑」，给一颗「在这台电脑上启动」，由人自己决定。

剩下的口子：老版本桌面端以前会在每台电脑上都把它起一遍，那几台上也都有 `satuwork.db`，这时还是先升级的那台
领走。认领的语句：

```sql
update catalog_items set "deviceId" = ? where id = ? and "deviceId" is null
```

在 `POST /runtime/bots/:id/local-bootstrap` 里做：

- 带条件的 update 改到了 → 归这台，正常发票。
- 没改到，且 `deviceId` 等于本机 → 正常发票。
- 没改到，且 `deviceId` 是别的值 → 409「这个本地 Bot 在另一台电脑上」。界面收到后从名册里拿掉这颗、
  不再试着启动；下一次拉名册它也不会再出现。
- `legacy-desktop` 视角（没带设备头）不认领：没绑定的照旧发票，已经归了别的电脑的回 409（§8）。

### 4.4 席位一侧（Bot 进程的请求）

Bot 进程拿 `sat_` 来的请求不带设备头，也不需要：**它是哪颗 Bot，就按那颗 Bot 判。**

- **拉目录、按 botId 取自己**（`/runtime/catalog?botId=`、`seatBotOf`）：`seat` 视角，账号下的本地
  Bot 都认，否则本地 Bot 连自己都拉不到。
- **派活名单**（`/runtime/catalog` 里的 `assignableFor`）和 **`POST /runtime/tasks` 的目标校验**：
  本地 Bot 只有在「发起派活的主 Bot 也是本地 Bot、而且 `deviceId` 和目标相同」时才算可派。
  - 远程主 Bot 不能给任何本地 Bot 派活——那等于让网页上的对话把活塞进某台电脑里。
  - 同一台电脑上的本地主 Bot 给本机的本地 Bot 派活照旧。
  - 判断收在 `lib/catalog.ts` 的 `canAssignTo(from, to)`；@ 名单（`GET /mentions`）和主 Bot 对话里
    @ 一颗 Bot（`POST /runtime/sessions/:id/messages`）也走它。
  - 名单收窄之后，`/runtime/catalog/version` 的指纹要用同一份收窄后的名单算，否则席位会每分钟白拉
    一次目录（见那里的注释）。

## 5. 新建本地 Bot：默认放进「本地 / Local」分类

`POST /runtime/bots` 带 `runtimeKind: 'local'` 时：

1. **必须是 `device` 视角**，否则 400「本地 Bot 只能在 Satuwork Desktop 里建」（`legacy-desktop`
   也拒——老壳子建出来的会是一颗没有主人的 Bot）。网页上「本地」那个选项本来就是灰的
   （`pages-bots.js`），这一条是服务端兜底。
2. 写入 `"deviceId"`，同时 upsert `desktop_devices`（设备名、平台从请求体的 `device` 字段带上来，
   取自 `__SATUWORK_DESKTOP_DEVICE__`）。
3. **在同一个事务里**（已经持有 `USER_BOT_QUOTA_LOCK`）找这个账号 `kind = 'local'` 的分类：
   - 有 → 把这颗放进去（`setBotFolder`）。
   - 没有、且分类数没到 `BOT_FOLDERS_MAX`（20）→ 新建一个，名字按账号语言取「本地」或「Local」，
     `kind = 'local'`，再放进去。
   - 分类已经满了 → 跳过这一步，Bot 放在未分类里。**建 Bot 不能因为分类满了而失败。**
4. 回执里多带一个 `folder`（新建或已有的那个分类，或 null），界面直接合进 `state.botFolders`、
   把这颗的 `folderId` 设好，不用再拉一次名册。

为什么按 `kind` 找而不按名字找：用户切了语言，按名字会再建出一个 Local；用户把它改名成「我的电脑」，
按名字找也会再建一个。按标记找，改名后照旧往里放；用户把这个分类删了，下次建本地 Bot 会再建出来。

- `bot_folders` 的 `publicBotFolder` 多回一个 `kind` 字段（`'local'` 或 null）。
- **空的「本地」分类不画。** 分类是账号级的，而本地 Bot 只在本机可见，所以网页、App、别的电脑上它会
  是空的。`shell.js` 的 `rosterGroups` 对 `kind === 'local'` 且里面没有可见 Bot 的分类直接跳过。
  B 机上这个分类里只会出现 B 自己的本地 Bot。
- 已有的本地 Bot **不自动挪进去**，不打乱用户已经排好的侧栏。
- 改成远程 / 拖出分类都是用户自己的事，不做任何强制。

## 6. 后台领活

- **`/runtime/local-routines/due` 改成按 botId 领**，和 `local-tasks` 一样：
  - Gateway：`dueRoutinesForLocalAccount` / `dueRoutineRetriesForLocalAccount` 多一个可选的
    `botId` 条件；带了就只交这颗的，不带（老版本）照旧全给。
  - Bot：`bot/src/local-routines` 的 `/due` 带 `?botId=<pinnedBotId()>`；领到不是自己的就不碰，
    等租约到期放回去（照 `local-tasks` 那段写法）。
- **派活的 owner 不改**，还是 `desktop:<accountId>`。本地 Bot 的进程只在它那台电脑上跑，按 botId
  领就够了，把设备 ID 写进 owner 只会多一套要迁移的值。
- `noteLocalPoll` / `localPolledSince` 不改：判的是「这颗 Bot 在不在线」，它只在一台电脑上跑。
- **通知上报**（`routes/notifications.ts` 里本地 Bot 那条）：Bot 已绑定设备时，只收那台设备报上来
  的（`device` 视角且 id 相同），否则 404。推到手机那条路本来就排除了本地 Bot
  （`lib/notifications.ts`），不用动。

## 7. 别的电脑上的本地 Bot 和配额

换了电脑、旧电脑丢了、数据目录被清，那台电脑名下的本地 Bot 在任何地方都看不到，却还占着
`MAX_USER_BOTS`（默认 20，`GATEWAY_MAX_USER_BOTS`）。

- `GET /runtime/bots` 的 `quota` 多回一项：`elsewhere: [{ deviceId, name, platform, lastSeenAt, count }]`
  ——只给设备和数量，不给 Bot 的名字和 id。网页、手机上也给（对它们来说全是「别的电脑」）。
- 新建 Bot 弹窗底部写「已建 X / 20 个 Bot，其中 N 个是其他电脑上的本地 Bot」（`pages-bots.js` 的
  `botQuotaNote`），点开按设备列出设备名、最后在线时间，每台一个「清除」。配额满了建不了的时候，
  人正好就在这一屏上。
- 清除走新接口 `DELETE /runtime/devices/:id/local-bots`：对这台设备名下的每颗本地 Bot 走和
  `DELETE /runtime/bots/:id` 相同的删除流程（含删除前审计），**不能拿本机的设备 ID 调**
  （本机的去 Bot 设置页一颗颗删）。删完那台设备没有 Bot 了就把 `desktop_devices` 那行也删掉。
- 老数据里没绑定的本地 Bot 不算「其他电脑上的」：它在每台桌面端上都看得到，可以直接删。

## 8. 兼容和发布顺序

桌面端的界面是打进安装包里的（`desktop-bundles-ui`），老壳子不会带设备头。

1. **先发 Gateway**（迁移 + §4 的规则 + `legacy-desktop` 兼容 + §6 的 routines botId 参数）。
   老壳子落进 `legacy-desktop`：还没绑定的本地 Bot 照旧看得到、起得来，不会出现「升了 Gateway 本地
   Bot 全没了」；已经被某台新桌面端认领走的它就看不到了（它起起来只是一个空工作区的进程，还会去抢那颗的活）；
   它也建不了新的本地 Bot（§5）。网页和手机上本地 Bot 立刻消失。
2. **同时发 bot 运行时**：`local-routines` 带 botId。不依赖新 Gateway（老 Gateway 不认这个参数，
   照旧全给，进程按 §6 跳过不是自己的）。
3. **再发桌面端**：`device.json`、注入脚本、`core` 的设备头、界面里的分类和配额那几处。
   装上之后第一次启动，老的本地 Bot 按 §4.3 归到这台电脑。
4. 等线上桌面端都升到新版之后，删掉 `legacy-desktop` 这条分支（没带头的桌面源按 `none` 算）。

这一轮没做、留给真机验证的：两台电脑同账号的完整流程（§9 桌面端那两条）、`device.json` 在 Windows
上的读写。

## 9. 测试

Gateway 单测 / e2e（`e2e/local-device.mjs`，另有 `bot-tasks` / `push` / `local-bootstrap` /
`local-routines` 跟着改了）：

- 同一账号、两个设备 ID：A 建的本地 Bot，A 的名册里有、B 的没有、不带头（网页）的没有。
- B 按 id 访问 A 的本地 Bot（改名、删除、记忆、`local-bootstrap`）都是 404。
- 老数据：两台并发 `local-bootstrap` 同一颗未绑定的，只有一台拿到票，另一台 409。
- 不带设备头建本地 Bot → 400。
- 建本地 Bot：没有「本地」分类时新建一个并放进去；已有时放进已有的；改过名的照样放进去；
  分类满 20 个时 Bot 照建、`folder` 为 null；两条并发创建只建出一个分类。
- 派活：远程主 Bot 的派活名单里没有本地 Bot；本地主 Bot 只看得到同一设备的本地 Bot；
  `POST /runtime/tasks` 指向别的设备的本地 Bot 被拒。
- `local-routines/due?botId=x` 只交 x 的任务；不带 botId 照旧全给。
- `legacy-desktop`（桌面源、无头）看得到全部本地 Bot，且不认领。
- `quota.elsewhere` 只含别的设备、不含 Bot 名字；清除接口不接受本机设备 ID。

桌面端（真机）：

- 两台电脑登同一个账号：各自建的本地 Bot 只出现在各自的侧栏里，且只在各自那台上起进程。
- 删掉 `device.json` 重启：本机的老本地 Bot 进到「其他电脑上」那一栏，可以在那里清掉。
