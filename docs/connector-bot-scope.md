# Satuwork：插件账号的 Bot 可见范围

插件（连接器）里的每一个账号（一把连接：`Gmail (default)`、`Gmail (personal)`、公司共用那把）
可以设「哪些 Bot 用得上它」：**默认所有 Bot**，也可以只勾一颗或几颗。

本文是执行规范，改写了 [connectors.md](./connectors.md) 里的几处（§1 非目标、§4「为什么不绑 Bot」、
§7 末尾「排序上有个诱惑要顶住」、不变量 20），那几处已经改过并指回这里。

---

## 1. 要什么、不要什么

**做成：**

1. 粒度是**账号（连接）**，不是插件（连接器）。同一个 Gmail 插件下，`work` 给所有 Bot，
   `personal` 只给「私人助理」那一颗
2. 两档：`all`（默认，含以后新建的 Bot）/ `bots`（只给名单里的，以后新建的 Bot **不**自动进）
3. 公司共用那把，每个员工也能给**自己的** Bot 设范围——设置跟人走，不改那一行连接
4. 不在名单上的 Bot：工具表里没有它、`@` 选单里没有它、调用被 Gateway 拒掉

**不做：**

- 工具子集按 Bot 分（「这颗 Bot 只能读不能发」）。工具开关仍然挂在安装上，一人一份
- admin 替员工设范围。Bot 是员工自己的，admin 看不到也不该挑别人的 Bot
- 「全都不给」这一档。那就是断开或「仅 `@` 时可用」，不另造第三种说法

**和 connectors.md 原则的关系。** 那一份拒绝「绑 Bot」的理由是：换一颗 Bot 就得重连一遍、
装一次到处能用。这次默认值仍然是 `all`，不设就和今天一模一样；收窄是员工主动做的，而且
只改「谁看得见」，不需要重新授权。所以它不是把绑定加回来，是在账号上多一个可选的收窄。

---

## 2. 数据模型

迁移 `0067-connector-bot-scope.ts`：

```sql
-- 一个人给一把连接设的 Bot 范围。没有这一行 = all（默认，也是今天的行为）。
create table if not exists connector_bot_scopes (
  "connectionId" text not null references connector_connections(id) on delete cascade,
  "accountId"    text not null references accounts(id) on delete cascade,
  mode           text not null check (mode in ('all', 'bots')),
  -- mode = 'bots' 时的名单；mode = 'all' 时恒为 []。
  "botIds"       jsonb not null default '[]',
  "updatedAt"    bigint not null,
  primary key ("connectionId", "accountId")
);
create index if not exists connector_bot_scopes_account on connector_bot_scopes ("accountId");
```

几个取舍：

- **为什么按 (连接, 账号) 存，而不是在 `connector_connections` 上加一列。** 公司共用那把是
  一行连接、全公司共用；范围是每个人对自己 Bot 的选择，放在连接行上就只剩一份
- **为什么 `mode` 和名单分开存，而不是「名单为空 = 全部」。** Bot 会被删。名单里只剩的那颗
  被删掉之后，「空」要是被读成「全部」，一把原本只给私人助理的个人邮箱就悄悄对所有 Bot
  开放了。有了 `mode`，删光了是「谁都不给」（失败时关），界面提醒去改
- **名单用 jsonb，不另开一张一 Bot 一行的表。** 读的时候总是和该账号当前的 Bot 名单
  （`botsFor`）取交集，删掉的、不属于他的 id 自然失效；不靠外键级联，也就没有上一条那个坑
- 写入时 `botIds` 去重、只收 `botsFor(companyId, accountId)` 里有的 id、至少一个
- 改回 `all` **不删行**，留一行 `mode='all'`：删掉的话条数和 `max(updatedAt)` 可能退回改之前，
  指纹（3.2）撞上旧值，席位判「没变」

`db/usage.ts` 加：

```ts
botScopesFor(accountId: string): Promise<Map<string /* connectionId */, BotScope>>
botScopeOf(connectionId: string, accountId: string): Promise<ConnectorBotScope | undefined>
setBotScope(connectionId: string, accountId: string, scope: BotScope): Promise<ConnectorBotScope>
type BotScope = { mode: 'all' } | { mode: 'bots'; botIds: string[] }
```

`lib/connectors.ts` 加一个**唯一的判定函数**，下面四处都用它，口径只有一份：

```ts
/** 这把连接对这颗 Bot 可不可见。没有 botId（脚本、老调用）时只认 all。 */
export function connectionVisibleTo(scope: BotScope | undefined, botId: string | null): boolean {
  if (!scope || scope.mode === 'all') return true
  return !!botId && scope.botIds.includes(botId)
}
```

判定之外，「取哪些连接、过哪些条件」也只有一份，同在 `lib/connectors.ts`：

- `usableConnections(db, accountId, companyId, bot)`：active、连接器在架且启用、本公司没禁、对这颗
  Bot 可见。目录下发、发消息时的 `@` 校验、`@` 选单三处都从它取；`bot` 传 `'any'` 是选单没带
  botId 的老页面
- `connectionUsableBy(conn, account)`：这把连接是不是这个人的（自己的，或本公司共用的）。MCP 端点
  的门和改「可用 Bot」的接口共用，跨人的边界只写一处

---

## 3. 在哪几处生效

### 3.1 目录下发（主要的那道）

`GET /runtime/catalog`（`gateway/src/routes/runtime.ts`，合成 `synth` 那一段）：

- 取出 `botScopesFor(account.id)`，`conns` 先按 `connectionVisibleTo(scope, botId)` 过滤，
  再合成 MCP 记录。**不可见的整条不下发**，不是下发了再藏——和 `mentionOnly`
  不同：那个要等被点名时立刻能用，这个不会被点名（见 3.3）
- 没带 `botId` 的调用只拿到 `all` 的那些（和知识库 §8.2 同一个走法）
- 不按 Bot 拉目录的路径（没带 `botId`，`bots` 是整份名单）**不按每颗 Bot 分算**：端点地址那时也不带
  `botId`，3.4 那道门会拒，分算出来也调不动。真正的席位（管家部署的和桌面端本地 Bot）都带
  `SATUWORK_BOT_ID`，一定按 Bot 拉；不带的只剩脚本和开发时手起的进程

### 3.2 目录指纹

`connectorStampOf()` 把 `connector_bot_scopes` 的 `max(updatedAt)` 和条数并进去。
不并的话改完范围，探针判「没变」，Bot 那边要等下一次重新部署才生效。
探针和整份目录必须一起改（两处都调 `connectorStampOf`），否则席位每分钟白拉一遍。

### 3.3 `@` 点名

- `GET /mentions` 加可选的 `?botId=`（当前对话的 Bot），候选按它过滤；不带（老页面）不筛。
  前端 `chat-composer.js` 的 `mentionsUrl()` 带上当前对话的 Bot，`chat.js` 换页时已经清掉
  `state.mentionOptions` 重拉
- 发消息的校验（`runtime.ts` 里逐个校验 mentions 那一段）：按 `sessionIndex(sessionId).botId`
  再判一次，不可见的**剔掉**进 `droppedMentions`，和「已断开」「被公司禁了」同一个待遇。
  界面漏了也进不去
- 和 connectors.md 不变量 21 一致：`@` 只放大可见性，不突破归属——Bot 范围也算归属的一部分

### 3.4 Gateway 的 MCP 端点（兜底）

`gateway/src/routes/mcp.ts` 的 `gate()` 在「装了」之后加一步：

```
… → install 存在 → connectionVisibleTo(scope, botId) → 工具在子集里
```

不可见：`tools/list` 回空表（不回错：回错席位会把整台服务器标成连不上），`tools/call` 回一句
工具结果「这个账号没有开放给这颗 Bot」，并落一行 `connector_calls`（`status: 'denied'`，不计费），
上游一次都不碰。附件上传位 `/files` 直接 403。

**要说清楚它挡的是什么。** `sat_` 票是按账号发的，URL 上的 `botId` 是席位自报的
（`gate()` 上那段注释）。所以这一道和 `mentionOnly` 的服务端那道一样：**挡 bug，不挡被
拿下的席位**——假也只能假成同一个人名下的另一颗 Bot。这个功能是员工给自己的 Bot 分工、
避免误用，不是跨人的安全边界；跨人的边界仍然是账号，一步没变。

和 `mentionOnly` 那道的一个差别：`botId` 缺席时**拒**，不放行。端点地址是 Gateway 在下发
目录时自己拼的（`runtimeConnectorServer` 的 `?botId=`），只要是按 Bot 拉的目录就一定带着；
没带的只可能是脚本或没带 `botId` 拉目录的老路径，而那条路本来就只拿到 `all` 的连接。

---

## 4. 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| PUT | `/me/connectors/:connectorId/connections/:connectionId/bots` | `{ mode: 'all' }` 或 `{ mode: 'bots', botIds: string[] }` |

- 个人连接：必须是自己的（`ownConnection`）。公司共用那把：同公司即可（它对员工本来就可见）。
  所以不复用 `PATCH`——那条只认 `scope='user'`，公司那把不让改 label，但要让设范围
- 校验：`botIds` 非空、去重、每个都在 `botsFor(companyId, account.id)` 里，否则 400 并指出哪个
- 写审计 `connector.connection.bots`（`detail: { connectionId, mode, botIds }`）。理由和
  `mentionOnly` 一样：它决定这把账号会被哪颗 Bot 隐式调用，是权限边界，不是显示偏好
- `GET /me/connectors/:id` 的每条连接多一个字段：

  ```jsonc
  "bots": { "mode": "bots", "botIds": ["bot_a"], "missing": 0 }
  ```

  `missing` = 名单里已经不在 `botsFor` 里的个数（Bot 被删了），界面用它提示。
  `publicConnection()` 收一个可选的范围参数，不在里面查库
- `GET /me/connectors/:id` 另带 `bots: [{ id, name, icon, origin }]`：「可用 Bot」的候选，和改范围时
  的校验是同一份 `botsFor`。不借侧栏那份名册——那份在没有席位机器时会藏掉公司的 Bot

---

## 5. 界面

`gateway/ui/pages-connectors.js` 的 `connectionRow()`，「仅 @ 时可用」旁边加一格「可用 Bot」：

- 收起时是一颗小按钮：`所有 Bot` / `私人助理` / `3 个 Bot`；名单里的全被删了时显示红字
  `没有 Bot 可用`
- 点开是弹层（复用现有 `satu-menu` 那套）：
  - 单选 `所有 Bot（以后新建的也算）` / `指定 Bot`
  - 选「指定 Bot」时下面是复选框列表，来自详情里的 `bots`，带 Bot 图标
  - 一句说明：「没勾上的 Bot 看不到这个账号的工具，也不能 @ 它」
  - 「保存」：一个都没勾时按钮禁用
- 公司共用那把也画这一格（别的按钮它都没有，这一格要有）
- 展开状态在 `state.connBotsOpen`；单选和勾选只动 DOM 不重画，保存时从那一块里读
- 插件页清单（`pages-plugins.js`）那一行不画，只在详情里设；清单行太挤

可选（第二步再做）：Bot 设置页加一段只读的「这颗 Bot 能用的插件账号」，按插件分组，
每行点进去跳插件详情。人常常是从「这颗 Bot 为什么能读我的私人邮箱」这个问题出发的。

---

## 6. 席位（Bot 进程）

**不用改。** 一个进程一颗 Bot，目录按 `botId` 拉，看不见的连接根本不在 `servers` 里；
`toolSchemasFor()`、`mentionGaps` 照旧。桌面端本地 Bot 走的是同一条 `/runtime/catalog`，
同样不用改。

`mentionGaps` 的那句提示（「去插件里看看那把连接的状态」）不用加 Bot 范围这一种原因：
不可见的连接在 Gateway 校验 mentions 时就被剔掉了，到不了席位。

---

## 7. 测试

- `e2e/connectors.mjs`「可用 Bot：…」：用一把连接、两颗 Bot（A、B），收窄到 A——
  1. 默认 `all`，详情带候选 Bot；空名单、别人的 Bot、认不出的 mode → 400，别人的连接 → 404
  2. 收窄后 B 的指纹变了；A 的目录里有、B 的没有、不按 Bot 拉的也没有
  3. `/mentions?botId=B` 没有、`?botId=A` 有
  4. 以 B 的名义打 MCP：`tools/list` 空表、`tools/call` 被拦且上游没被碰、没带 botId 也拦、`/files` 403
  5. 删掉 A → 详情是空名单 + `missing: 1`，B 仍然没有（不是回到全部）
  6. 改回 `all` → B 又有了
- `e2e/connectors.mjs`「界面：员工的详情页…」：三种范围的收起文案、公司那把也有这一格、展开后的勾选
- 发消息时按会话 Bot 剔掉 mentions：和选单、目录共用 `connectionVisibleTo`；`gateway-chat` 那条
  「@ 点名：Gateway 把失效的剔掉」照旧通过
- 不设范围的老数据：迁移后行为和之前完全一样（无行 = all）

---

## 8. 落地

迁移 0067；`db/usage.ts`（读写）；`lib/connectors.ts`（判定与对外形状）；`routes/runtime.ts`
（目录、指纹、发消息校验）；`routes/mcp.ts`（兜底那道门）；`routes/connectors.ts`（`PUT .../bots`、
详情、`/mentions`）；界面 `pages-connectors.js` / `pages-plugins.js` / `chat-composer.js` / `chat.js`。
席位（`bot/`）与桌面端一行未改。

---

## 9. 新增的不变量

接在 connectors.md §14 后面（并改写第 20 条）：

20. （改写）一个账号连的每一把连接，默认他名下**所有** Bot 都看得见；他可以把某一把收窄到
    指定的几颗 Bot。收窄只影响可见性，不改归属、不需要重新授权
25. 「可见」的判定只有一份（`connectionVisibleTo`），目录下发、指纹、`@` 校验、MCP 端点四处共用
26. 名单里的 Bot 删光了是「谁都不给」，不是「回到全部」
27. 按 Bot 收窄挡的是误用，不是跨人的攻击：`botId` 是席位自报的，跨人的边界仍然是账号
