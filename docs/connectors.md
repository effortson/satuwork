# Satuwork：连接器（Connector）与按次计费

给 Bot 接上外部 SaaS（Gmail、Slack、Notion、Jira……）。第一家供应商是
[Composio](https://composio.dev)，但**代码里不写死它**：中间隔一层 provider，换供应商
只换一个文件。每一次工具调用按次计价、按次记账、按次统计。

本文是执行规范。和 [gateway-runtime.md](./gateway-runtime.md) 冲突处以那一份为准；本文
只是在它的三层目录、席位模型、`/v1` 计费口径上**加一类东西**。

**唯一一处例外，在这里点名：** `gateway-runtime.md` §12 第 5 步「发消息：已在跑则
steering，否则新 turn」被本文改写成三岔（§7「带 `@` 的消息不走 steering」）。那一份
文档要加一行指回来。

---

## 1. 目标与非目标

**做成：**

1. `owner` 在平台配一次供应商密钥，决定「连接器市场」里上架哪些
2. 员工自己在市场里**安装**需要的那几个（不是默认全开，也不是管理员替他开），再点「连接」
   授权自己的 Gmail。一个连接器可以连**多个账号**（工作的、个人的），各自有名字
3. **连接器绑账号，不绑 Bot。** 装上了，这个员工名下的每一颗 Bot 都能用；换一颗 Bot
   聊天不用重装、不用重连
4. 两种用法都要成立：**隐式**——「查看我的邮件」，模型自己挑工具；**显式**——输入框里
   `@` 出一把连接（`Gmail (personal)`），这一轮就点名用它。点名是一个结构化的东西，
   不是一句提示词
5. 上一轮还在跑的时候发一条带 `@` 的：**排队，不插话**。它压成输入框顶上的一行小字，
   随时能取消，等这一轮跑完自动接上
6. 每一次工具调用**经过 Gateway**，落一行流水，按次计价，从公司余额里扣
7. 三个范围的统计：平台（按公司 / 连接器 / 工具）、公司（按员工 / 连接器）、员工（自己）
8. provider 层：`ConnectorProvider` 接口 + `composio` 实现。第二家供应商只加一个文件

**先不做：**

- **「这个连接器只给某颗 Bot 用」。** 绑定单位是账号，不是 Bot——这是产品形态定下的，
  不是省事。代价（工具表被撑大）在 §7 里正面处理，不靠加一个绑定层去绕
- `@` 出 **Bot** 和 **Routine**（选单里另外那两类）。`mention` 块的形状本文一次定死，
  三类共用；但跨 Bot 的 `@` 走 Gateway 那条路，是另一份文档的事
- Trigger / Webhook（「收到新邮件就叫醒 Bot」）。那是另一条入站链路，不挤进本文
- 白标 OAuth（用公司自己的 Google App 而不是 Composio 的）。接口留了口子，v1 不接
- 「需审批」的真正拦截。现在 MCP 的 `perm` 只存不拦（`bot/src/catalog/index.ts:316`
  存下来就没人看了），连接器沿用同一现状，不新造一套半成品
- 按连接器卖包月套餐。v1 只有「一次调用多少钱」

---

## 2. 为什么 Bot 不直连 Composio

最省事的接法是把 Composio 的 MCP 地址当成一条普通 MCP 记录填进公司目录——现有代码
今天就跑得起来，一行不用改。但这条路走不通，三条理由，每一条单独都足够：

1. **计费必须过 Gateway。** 计费的前提是数得到。Bot 直连的话，调用发生在席位机器和
   Composio 之间，Gateway 一无所知；只能事后去 Composio 那边对账，而那份账没有
   `accountId`、没有 `botId`，也不按我们的口径分公司
2. **密钥不下机器。** 不变量 9 / 10 说的是 provider key 不进 Bot 的磁盘和环境。
   Composio 的 API key 是同一类东西，而且更狠：**一把平台 key 能操作所有用户的所有
   连接**。它落到席位机器上，等于把全平台所有人的 Gmail 交给了那台机器
3. **换供应商要一处改。** 直连意味着「endpoint 写在每家公司的目录里」，换供应商要去
   改 N 家公司的 N 条记录，还得挨个重新授权

所以：**Bot 打 Gateway，Gateway 打供应商。** 这和模型那条链路（Bot 打 `/v1/*`，
Gateway 拿平台密钥打上游）是同一个形状，不是新发明。

---

## 3. 总拓扑

```
浏览器（连接器菜单）
  ├─ owner   /connectors        市场上架什么、配供应商密钥、定单价
  ├─ admin   /connectors        禁用哪几个、公司共用的连接、谁装了、花了多少
  └─ member  /connectors        市场里自己装；每个连接器下连几个账号
                    │
                    ▼
                Gateway ───────────────────────────► Composio（backend.composio.dev）
                  ├─ connectors/provider 层           auth config / connected account
                  ├─ /mcp/connectors/{id}   ◄──┐      tools.list / tools.execute
                  ├─ connector_calls（流水）    │
                  └─ 余额拦截（402）           │
                                              │ MCP over HTTP（sat_ 票）
                                    席位实例（Bot 进程）
                                      现成的 McpHttpClient，不知道 Composio 存在
```

Bot 那一侧**一行业务代码都不用改**：Gateway 在 `/runtime/catalog` 里把该账号每一把已连接
的账号合成成一条普通的 `kind: 'HTTP'` MCP 服务器记录，`endpoint` 指回 Gateway 自己。现有的
`CatalogService.connectMcp()` 照常 initialize / tools/list / tools/call，只是对面坐着的
是我们。

---

## 4. 三样东西：上架、安装、连接

分不清这三样，后面每一节都会歪。

| 东西 | 谁做 | 存在哪 | 一句话 |
|---|---|---|---|
| **上架** | `owner` | `catalog_items` `kind='connector'` `scope='global'` | 市场里有 Gmail 这个东西 |
| **公司策略** | `admin` | `catalog_items` `scope='company'` | 本公司**禁用**哪几个（默认全放行） |
| **安装** | 员工自己 | `connector_installs` | 我要用 Gmail，以及我开了它的哪几个工具 |
| **连接** | 员工自己 | `connector_connections` | 我授权了哪几个 Gmail 账号（`default`、`personal`……），每把可设「仅 `@` 时可用」 |

一个安装底下可以挂**多把连接**——截图里 Gmail 下面并排的 `default` 和 `personal` 就是
两行 connection、一行 install。安装和连接必须拆开，因为「装了但还没授权」是一个真实
状态（市场里点了 Add，OAuth 还没走完），合成一张表就只能用 `status` 硬编出来，而那时
「他到底装了几个」这个问题就没法回答了。

### 上架的定义

```jsonc
{
  "vendor": "composio",        // provider 层认哪一家
  "toolkit": "gmail",          // 供应商侧的 toolkit slug
  "authConfigId": "ac_xxx",    // 供应商侧的 auth config。owner 配，公司和员工都看不见
  "multiAccount": true,        // 允许连多个账号
  "perm": "可写",              // 沿用 MCP 的三档，只标注不拦截
  "category": "邮件"           // 市场里的分组
}
```

**工具子集不在这里。** 开哪几个工具是**安装**上的选择（截图里的「29 of 29 enabled」），
不是上架时定死的——同一个 Gmail，行政要发邮件，研发只想读。放在上架定义里，等于让
`owner` 替全平台所有人做这个决定。

### 公司这一层是黑名单，不是开关

原来的设计是「admin 启用了员工才能装」。改成**默认放行 + 可禁用**，因为产品形态是员工
自助：每加一个连接器都要等管理员点一下，市场就没有意义了。

但公司这一层不能没有：数据出境这件事（§16）是公司要担责的，得有地方摁住。所以公司层
只存**否定**——`{ blocked: true, reason: '合规未过' }`。被禁的连接器在员工的市场里灰着，
写明原因；已经装了的立刻失效，不删记录（禁令撤销后还能接着用）。

### 为什么不绑 Bot

一个员工名下的每一颗 Bot 都看得见他装的全部连接器。这是产品形态，不是实现偷懒——
连接器是「我这个人有哪些账号」，Bot 是「我让谁替我干活」，把账号挂到某一颗 Bot 上，
换一颗就得重连一遍。

代价是实打实的：截图里光 Gmail 一个连接器就有 29 个工具，装 8 个连接器就是两百多个
工具进每一颗 Bot 的 system prompt。§7 的三条防线是为这件事准备的，其中第一条（员工
自己关掉用不上的工具）在截图那个界面里已经有位置了。

---

## 5. Provider 层

`gateway/src/connectors/`：

```
types.ts     接口 + 能力位
composio.ts  第一家实现
index.ts     注册表：按 vendor 取实现，取不到就 501
```

接口窄到只剩「换供应商时真的会变的东西」：

```ts
export interface ConnectorProvider {
  readonly vendor: string
  /** 这家能干什么。调用方按位判断，不按 vendor 名字判断。 */
  readonly caps: {
    /** 能直接给出一个 per-user 的 MCP 地址（Composio 能，将来可以少一跳） */
    mcpUrl: boolean
    /** 工具多到装不下时，有没有服务端搜索 */
    search: boolean
    /** 同一个用户能不能连同一个 toolkit 的多个账号（Composio 能） */
    multiAccount: boolean
  }

  /** 有哪些连接器可放开。owner 那一屏的选单。 */
  listToolkits(): Promise<Toolkit[]>
  /** 某个连接器有哪些工具，带 JSON Schema。admin 勾选工具子集用这个。 */
  listTools(toolkit: string): Promise<ToolDef[]>

  /** 发起授权，返回让浏览器跳过去的地址。同一个 externalUserId 可以连多次（多账号）。 */
  initiate(input: { toolkit: string; authConfigId: string; externalUserId: string; callbackUrl: string })
    : Promise<{ connectionId: string; redirectUrl: string }>
  /** 授权成功了没有。回调之后轮询它，不信浏览器带回来的参数。 */
  status(connectionId: string): Promise<{ status: 'pending' | 'active' | 'failed'; error?: string }>
  disconnect(connectionId: string): Promise<void>

  /** 真正的一次调用。**唯一会产生费用的方法。** */
  execute(input: { tool: string; externalUserId: string; connectionId: string; args: unknown; signal: AbortSignal })
    : Promise<{ ok: boolean; result: unknown; /** 上游真的执行了 */ billable: boolean }>

  /** 给一份文件要上传位：句柄 + 席位自己 PUT 字节的预签名地址（§7「附件」）。**不是执行，不计费。** */
  prepareUpload(input: { toolkit: string; tool: string; filename: string; mimetype: string; md5: string; signal: AbortSignal })
    : Promise<{ file: { name: string; mimetype: string; s3key: string }; upload: { url: string; headers: Record<string, string> } | null }>
}
```

### Composio 这一家怎么映射

| 接口 | Composio 侧 |
|---|---|
| `listToolkits` | `GET /toolkits` |
| `listTools` | `GET /tools?toolkit_slug=` |
| `initiate` | `POST /connected_accounts/link { auth_config_id, user_id, callback_url, allow_multiple: true }` → `connected_account_id` + `redirect_url` |
| `status` | `GET /connected_accounts/{id}` → `ACTIVE` / 其他 |
| `execute` | `tools.execute(slug, { user_id, connected_account_id, arguments })` |
| `prepareUpload` | `POST /files/upload/request { toolkit_slug, tool_slug, filename, mimetype, md5 }` → `key`（就是 `s3key`）+ 预签名地址；字节由**席位**自己 `PUT` 到那个地址（不带 x-api-key） |

鉴权是 `x-api-key: <平台 key>`。密钥存在**已有的** `platform_credentials` 表里，
`provider = 'composio'`——它和模型供应商密钥是同一种东西（平台一把、不回显、不下发），
没有理由另开一张表。

`externalUserId` 用 `sw_{accountId}`，公司级连接用 `swc_{companyId}`。三条理由：邮箱会
变、邮箱是 PII（进了供应商侧就删不掉了）、加前缀是给同一个 Composio 项目里将来别的
东西留位置。

**用官方 SDK 还是裸 `fetch`：裸 fetch。** 接口就上面六个方法，而 `@composio/core` 会把
一整套 provider 适配层拖进控制面——那些东西是给「agent 跑在你自己进程里」准备的，我们
的 agent 跑在席位机器上。实现时逐条对着 API reference 钉版本，别照抄本文里的路径。

**`initiate` 那一条踩过一次坑，记在这儿。** 老的 `POST /connected_accounts`（`auth_config`
和 `connection` 两个嵌套对象）对「Composio 托管的 OAuth」已经不受理了，回的是一句
`Use POST /api/v3/connected_accounts/link instead`，而那句英文会一路顶到员工的插件弹窗
上。新的 `/connected_accounts/link` 对所有认证方式都是推荐路径，所以只留这一条。
**`allow_multiple: true` 不能省**：一个安装底下的几把连接（`default`、`personal`……）
`user_id` 和 auth config 完全一样，不带这个标记的话第二次 link 会把同一把 connected
account 还回来，两行本地记录共用一个 externalId，断开其中一个另一个跟着废。允不允许
第二把由我们自己判（§4 的 `multiAccount`），走到 provider 这一层就是已经准了。
e2e 里的假 Composio 照着上游原话把老路打回（`e2e/connectors.mjs`），走回去立刻红。

**换供应商时会变的只有 `composio.ts`。** 会不好受的地方提前说清楚：工具 slug
（`GMAIL_SEND_EMAIL`）是 Composio 的命名，换家之后工具名会变，而工具名已经进了历史
会话的 JSONL。所以流水表里 `vendor` / `connector` / `tool` 三列都存，不合并成一个串。

---

## 6. 安装与授权

### 装

员工在 `/connectors` 那一屏的市场里点「安装」→ `POST /me/connectors/:id/install` → 写一行
`connector_installs`（`enabledTools` 留空 = 全开）。**这一步不碰供应商**，没有网络往返，
点完立刻是「已安装、未连接」。

卸载（`DELETE`）连带把该员工在这个连接器下的所有连接都断掉，并调
`provider.disconnect()`——留着一把没人管的 OAuth 授权比什么都糟。

### 连

「Add Another Account」→ `POST /me/connectors/:id/connections` `{ label }`：

1. Gateway 写 `connector_connections`（`status: 'pending'`），调 `provider.initiate`，
   `callbackUrl` 是 `{GATEWAY_URL}/oauth/connectors/callback`
2. 响应给 `redirectUrl`，浏览器**新开一页**跳过去，在 Google 那边完成授权。不顶掉当前
   这一页：插件弹窗多半是盖在对话上开的，整页跳走等于把草稿、滚动位置、刚选好的那颗
   Bot 一起扔了，而人只是想加一个邮箱。新标签页要在**点击那一下里**就开出来（地址还得
   先向后端要，`await` 之后再 open 会被拦截器当成非用户触发挡掉），被挡下来就退回整页跳
   ——什么都不发生比换一页更糟。回到原来那一页时补取一次账号列表：授权发生在另一个
   标签页里，这一边一个事件都收不到
3. 供应商回调 `/oauth/connectors/callback`
4. **Gateway 不信回调里带的任何状态**，拿 `connectionId` 回头调 `provider.status()`，
   `ACTIVE` 才把行改成 `active`。回调是从公网进来的，参数谁都能伪造；而这一步的产物是
   「这个员工现在能操作这个 Gmail 了」
5. 落一条审计（`connector.connect`），并让该账号的目录指纹变一下（见 §7）

`label` 是员工自己起的名字（`default` / `personal` / `公司邮箱`），它会**出现在工具名的
前缀里**（§7），所以要限长、限字符集（`[a-z0-9_-]{1,16}`），并且在同一个安装下唯一。
起名这件事不能省成自动编号：模型要靠这个名字判断「往哪个邮箱发」。

失败或用户中途放弃：行留在 `pending`，界面显示「未完成」，再点一次重来。**不删**——删了
之后「他到底试没试过」就查不到了。

### 「仅 `@` 时可用」

每把连接上有一个 `mentionOnly` 开关（默认关）。打开之后，这把连接**不进默认工具表**，
只有当这一轮被 `@` 点名时才生效。

**它照样下发到席位**（目录里带一个 `mentionOnly: true` 的标记），席位照样连上、照样把
工具注册好——只是不算进工具表。不下发是不行的：真被点名时那一轮已经在组请求了，那时
再去和供应商握手就晚了。过滤发生在**工具表**这一层，不是在下发这一层。

它解决的是一件很具体的事：截图里用户只说了「查看我的邮件」，Bot 就把工作邮箱和个人
邮箱一起读了。公司邮箱随便读没问题，个人邮箱应该是「我点名了你才能碰」。没有这个开关，
唯一的办法是把个人邮箱整个断掉——那就等于没连。

顺带它也是 §7 工具膨胀的一个出口：不常用的连接设成「仅 `@` 时」，平时一个工具都不占。

### 公司共用的那一把

有些账号是公司的（共享的 Notion、客服邮箱）。`admin` 在公司那一屏连一把
`scope: 'company'` 的，`externalUserId` 用 `swc_{companyId}`。它对员工表现为**该连接器下
多出来的一个账号条目**（label 固定是 `company`，不可改、不可断），和自己连的那几把并排。

统一成「连接 = (连接器 × 主体 × label)」之后，个人连接和公司连接在下游是同一种东西——
合成工具、计费、统计都不用分叉。差别只在谁能建、谁能删。

---

## 7. 工具怎么到 Bot 手里，以及 `@` 怎么点名

### 合成的 MCP 记录：一把连接一条

`/runtime/catalog`（`gateway/src/routes/runtime.ts:93`）在 `servers` 数组里追加：**该账号
每一把 `active` 的连接一条**。不是每个连接器一条——`default` 和 `personal` 是两条。

```jsonc
{
  "id": "conn_<connectionId>",
  "name": "Gmail (personal)",
  "kind": "HTTP",
  "endpoint": "https://gw.example.com/mcp/connectors/<connectionId>?botId=<botId>",
  "mentionOnly": false,
  "token": "<该席位的 sat_ 票>",
  "timeoutMs": 60000,
  "perm": "可写",
  "enabled": true
}
```

一把连接一条，有三个好处，每一个都不是靠写代码换来的：

1. **模型天然选得动账号。** `mcpToolName(serverName, toolName)` 拿服务器名做前缀，于是
   工具名长成 `gmail_personal__send_email` 和 `gmail_default__send_email`。不用给每个工具
   加一个 `account` 参数，也不用指望模型读懂参数说明
2. **计费落得到具体哪个账号。** 流水行上直接就有 `connectionId`
3. **断开一把不影响另一把。** 指纹一变，席位下一轮探针就少了那一条

`publicBot` 把这些合成 id 并进**每一颗** Bot 的 `mcps` 数组（连接器绑账号，不绑 Bot），
`bot/src/agent/index.ts:535` 的 `toolSchemasFor()` 照现有逻辑走，Bot 那边一行不用改。

### 三个必须改的地方

1. **`timeoutMs` 要能下发。** `bot/src/catalog/mcp.ts:77` 写死 `AbortSignal.timeout(8000)`。
   八秒对本地 MCP 够用，对「发一封邮件」「查一遍 CRM」不够——这类调用十几秒是常态。
   `McpHttpClient` 加一个超时参数，连接器那条给 60 秒。
   Gateway 侧对上游设 **45 秒**上限：必须比客户端**先**超时，否则 Bot 那边已经断了，
   我们还在等，这次调用记不到结果，钱也说不清收没收
2. **指纹要跟着安装和连接走。** `catalogStamp()` 现在只看 `catalog_items` 的 `updatedAt`
   和条数。员工装一个连接器、连一个新邮箱、关掉几个工具，`catalog_items` 一个字节都不会
   变，席位那边的探针就判「没变」，工具永远不出现——直到有人重新部署。把该账号
   `connector_installs` 和 `connector_connections` 的 `max(updatedAt)` 与条数并进指纹。
   装完到能用之间隔一个探针周期（一分钟），界面上要照实说
3. **`/mcp/connectors/*` 只认 `sat_`。** 和 `/runtime/catalog` 同一条规矩：这条路上跑的是
   公司的真实数据操作，登录 JWT 能进来的话，任何一个成员在浏览器里就能用别人的授权

### Gateway 的 MCP 端点

`POST /mcp/connectors/:connectionId` 实现三个方法，别的一律 `-32601`：

- `initialize` — 返回固定的 server info
- `tools/list` — 这把连接对应连接器的工具表 ∩ 员工开着的那些。**不计费**
- `tools/call` — 见 §8

`tools/list` 的边界判定顺序，一步都不能省：

```
sat_ 票 → account
connection.accountId == account.id（或 scope='company' 且同公司）
connection.status == 'active'
该连接器没被本公司 blocked
install 存在，且 tool ∈ install.enabledTools（空 = 全开）
```

URL 上的 `botId` **只用于统计归因，不参与鉴权**。它是席位自己填的，可以是假的；但假也只
能假成同一个账号名下的另一颗 Bot——账号才是真正的边界。写清楚这一条，免得将来有人
把权限判断挂到它上面。

### `@` 点名：一个内容块，不是一句提示词

输入框里 `@` 出来的东西，发出去时是消息的一部分（截图里那个 `Gmail (personal)` 药丸就
贴在「查看最新邮件」前面）。它必须是**结构化**的：把它降级成一句「用户提到了
Gmail (personal)」的纯文本，Bot 就分不清「用户点名了这把连接」和「用户碰巧打了这几个
字」，而这两件事的后果差得很远。

所以消息内容块加一种（`gateway-runtime.md` §9 的 v4 加了 `image`，这次是 v5）：

```jsonc
{ "type": "mention", "kind": "connector", "id": "conn_xxx", "label": "Gmail (personal)" }
```

`kind` 现在只用 `connector`，但形状按三类定死（`bot` / `routine` 也在那个选单里）——
三类各造一个块，历史会话里就会长出三种彼此不兼容的提及。

**v4 → v5 不需要专门的迁移代码**，理由和 v3 → v4 一样：老日志里根本没有 `mention` 块，
走已有的「版本号低于当前就就地升级」那条路即可。

**存结构，进模型时转成一句话。** JSONL 里躺着的是上面那个块，组模型请求时把它渲染成
`[本轮指定：Gmail (personal)]` 拼进用户消息。这样不变量 7（进模型的内容必须能从 JSONL
重建）仍然成立，模型那边也不用认识一种它没见过的块。

### 点名之后这一轮发生什么

`bot/src/agent/index.ts:199` 的 `toolSchemasFor(bot)` 就在 `runTurn` 里，**工具表本来就是
每轮现算的**，把这一轮的 mentions 传进去即可，不用改结构。三条规则：

1. **点名是「点名」，不是「限定」。** 被点的那把连接的工具排到工具表最前，并在用户消息
   里带上那句 `[本轮指定：…]`。**不把别的工具拿掉**——「@Gmail 看看邮件，然后在 Notion
   建个页面」是完全正常的一句话，硬过滤会把它变成半个功能
2. **被点名的连接免于截断。** §7 那条 64 个工具的上限，截断时先保留被点名的。否则会出现
   「`@` 出来的东西反而调不到」——这是所有故障里最难跟用户解释的一种
3. **`mentionOnly` 的连接只有被点名时才出现在工具表里。** 这也是唯一能让它出现的方式
4. **顺序有意义。** 被点名的工具要排到工具表**最前**——表一长，模型就在前几个里选，
   排在第 40 位等于没点。这一条落在 `bridgeTools` 上：它收的必须是一份**有序清单**，
   不是一个名字集合，否则顺序在那里被 `ctx.tools.schemas()` 的注册顺序覆盖掉

### 点名了、工具却不在表里

两步，缺一不可（`bot/src/agent/index.ts` 的 `mentionGaps`）：

1. **先补拉一次目录。** 最常见的一种是「刚连上就来用」——连接是几十秒前在浏览器里授权
   的，而席位一分钟才探一次（`catalog.poll`）。等下一轮探针的话，用户得到的是一句「我
   没有邮件工具」，然后他会以为授权失败，回去把连接重做一遍。只在有点名且确实缺工具时
   才拉，不摊到每一轮上
2. **拉完还是没有，就把实情写进这一轮的系统提示**：哪几把没挂上、不要另找办法代替、
   直接告诉用户去「插件」里看看那把连接的状态。

**不说这一句的代价是模型开始编。** 线上真发生过：用户 `@Gmail (default)` 说「查看邮件」，
那把连接的工具没挂上，模型一无所知，于是自己找了个替代方案——「你指定的 Gmail 应该是指
用桌面浏览器操作 Gmail」，接着去开虚拟桌面里的 Chrome。用户看到的是一屏莫名其妙的 terminal
调用，而真正的问题一个字都没提到。这段话**只进这一轮的系统提示**，不写进消息：重放时
工具表可能已经好了，那时不该还带着它（不变量 7）。

**Gateway 必须校验 mentions，不能原样透传。** 发消息是 Gateway 反代到席位的
（`gateway-runtime.md` §12）；浏览器传上来的 `conn_xxx` 要逐个查：属不属于这个账号、
是不是 `active`、连接器有没有被公司禁。不合格的**剔掉**并在响应里说明，不是报错整条
消息失败。席位那边收到什么就注入什么，它不该也没法做这个判断。

### 带 `@` 的消息不走 steering，排队

对话正在跑的时候再发一条消息，现在走的是 steering（`bot/src/agent/index.ts:114`）：话插
进正在进行的这一轮。但**这一轮的工具表早就定了**——而 `@` 的全部意义就是改工具表。
两件事天生不兼容：插进去，点名静静地不起作用；不插进去，用户以为消息丢了。

所以发消息从两岔变成三岔（这一条改写 `gateway-runtime.md` §12 的第 5 步）：

| 情况 | 走法 |
|---|---|
| 没在跑 | 新 turn（不变） |
| 在跑，消息**不带** `@` | steering（不变） |
| 在跑，消息**带** `@` | **入队**，这一轮跑完自动接上 |

分岔按**校验之后**的 mentions 算（§7 上一节：Gateway 会把不属于你的、断了的、被公司禁
的剔掉）。剔干净了就等于没点名，走 steering——不能按浏览器发上来的原始数组判断，
否则「点名一个已经断掉的连接」会得到一次莫名其妙的排队。

**队列在实例上，不在浏览器里。** 放浏览器最省事，但刷新一次就丢、两个标签页各排各的，
而消息其实已经发出去了——最糟的一种状态是「dock 没了但消息还会跑」。落在实例的
`satuwork.db` 里（`gateway-runtime.md` §13 已经说了那里放队列），刷新、换设备、进程重启
都还在。

**不写 JSONL。** 一条被取消的排队消息从没进过模型，写进去会破坏不变量 7（进模型的内容
必须能从 JSONL 重建）——重放时它会凭空多出一条用户消息。真正跑起来的那一刻，它照常
append 一条 `user/message`，和别的消息没有区别。

队列语义，三条：

1. **一条一条跑**，不合并。它们是不同的指令，合并会让 `@` 的归属乱掉
2. **上限** `SATUWORK_QUEUE_MAX`（默认 5）。满了发消息返回 429 和一句人话，不静默丢
3. **取消要认 id。** 用户点取消的同一刻，这一轮正好结束、队首已经被取出开跑，是必然会
   撞上的竞态。取消带 `queueId`，已经开跑的返回 409 `已经开始执行`，浏览器把那一行从
   dock 变成正常的消息气泡。**静默失败不行**——用户会以为取消成功了

发消息的响应因此要说清楚这条去了哪儿。这里有个现成的位置：`bot/src/web/index.ts:117`
已经在按分支回 `{ steered: true }` 或 `{ accepted: true }`，加第三种
`{ queued: true, queueId }` 就行——那句「前端不需要知道这个分支」的注释要跟着改掉，
现在前端**需要**知道，它得决定画 dock 还是画气泡。

队列变化经 SSE 广播（`queue/update`，带当前快照），刷新后从快照恢复。

### 工具名还原：按真清单对，不靠猜前缀

下发时去掉 toolkit 前缀（`GMAIL_SEND_EMAIL` → `SEND_EMAIL`），调用时要还原回去。
**还原必须拿真清单对**（那份清单本来就缓存着），不能反过来无条件补前缀：去前缀只在
「slug 带前缀」时发生，补前缀却是无条件的，两者对**不带前缀的 slug** 不互逆。Composio
的自定义工具就是这种（`LOCAL_GMAIL_GET_IMPORTANT_EMAILS`），猜出来会变成
`GMAIL_LOCAL_GMAIL_…`——工具表里有、点了永远失败，日志上还看不出为什么。

清单拉不到时才退回猜前缀：那时宁可猜错一个，也好过把所有调用堵死。两条路都保住同一个
边界——结果要么来自这个 toolkit 的清单，要么带着它的前缀，跨 toolkit 够不着。

### 附件：先暂存，再调用

供应商的工具**不收字节，也不收路径**。`GMAIL_SEND_EMAIL` 的 `attachment` 长这样（Composio
叫 `FileUploadable`，schema 上标着 `file_uploadable: true`）：

```jsonc
{ "name": "报价.pdf", "mimetype": "application/pdf", "s3key": "<供应商存储里的 key>" }
```

`s3key` 只能从供应商的文件接口换来，而席位工作区里的文件只在席位机器上——供应商那边
永远不存在。没有这条路的时候线上真发生过一次：模型把工作区路径填进 `s3key`，上游去取
就是 404，模型把这一步解释成「附件接口坏了」，然后把邮件改成不带附件的草稿转人工。

三段，各管一件事：

1. **Gateway 开一条「要上传位」的路**：`POST /mcp/connectors/:connectionId/files`，body 是
   `{ tool, name, mimetype, md5, size }`（JSON，**不是字节**）。门和 `tools/call` **一样一道不少**
   （票 → 归属 → active → 公司没禁 → 装了 → 工具在开着的子集里）——关掉的工具附件也传不上去，
   否则它就是一条把文件送出公司的旁路。Gateway 调 provider 的 `prepareUpload`，把
   `{ file: { name, mimetype, s3key }, upload: { url, headers } | null }` 还给席位。**不计费、
   不落流水**：上游没有因此执行任何工具，和 `tools/list` 同一档。超过
   `CONNECTOR_UPLOAD_MAX_BYTES`（默认 25 MB，Gmail 单封的上限）在要位子之前就 413；时限
   `CONNECTOR_UPLOAD_TIMEOUT_MS`（默认 30 秒）是那一次往返的
2. **席位一把工具** `connector_upload_file(tool, path, target?)`（`bot/src/tools/connector.ts`）：
   `tool` 是接下来要调的那把 `mcp_*`，由目录的 `connectorToolOf()` 反查到连接的 `/files`
   地址、票和远端工具名；`tool` 是 `SW_RUN` 那种元工具时再用 `target` 说真名。先算 md5 和
   大小去要上传位，再把字节**自己** `PUT` 到票里的预签名地址（照票里的 `headers` 发；
   `upload` 为 null 是供应商按 md5 去重命中，不用再传）。回给模型的话里**原样**带着句柄，
   模型照抄就能填。risk 是 `external`、**不带 `write`**：「关掉外发」的 Bot 要拦得住它
   （policy 按参数里那把 `mcp_*` 的连接判，判据就是那把的判据），但不弹确认卡——文件到了
   暂存区还没到任何人手里，真正发出去的是下一把工具，而那一把自己有卡。同一封邮件两张卡，
   人学到的是闭眼点批准。工具表里一把连接器工具都没有时它也不进表
3. **schema 里说出来**：`tools/list` 和 `SW_DESCRIBE` 下发前过一遍 `annotateFileParams()`
   （`gateway/src/lib/connectors.ts`），给每个文件参数的说明补一句「先调 `connector_upload_file`，
   把返回的 `{ name, mimetype, s3key }` 原样填这里，不要自己编 s3key」。**只改说明，不改形状。**
   不补的话模型只看得到三个字符串，不知道 `s3key` 从哪来

**字节为什么不经 Gateway。** 第一版是席位把字节 POST 到 Gateway、Gateway 再 PUT 给供应商。
Gateway 跑在 Vercel 函数里，请求体有 4.5 MB 的硬顶：一份 11.5 MB 的手册被 Vercel 的 413 挡在
路由之外，我们自己那道 25 MB 的闸根本没轮到。和 `runtime.ts` 里会话附件改成直传是同一个
教训。预签名地址不带供应商密钥，所以「密钥不下机器」（§2）不破；要位子那一步仍然经 Gateway，
门也仍然在 Gateway。文件名在 body 里不在查询串里：查询串会进访问日志，而文件名常常就是内容本身。

暂存是**短期**的（供应商文档明说）：上传要紧挨着调用做，不能提前很久、也不能跨轮复用。
工具回话里写了这一句。

### 两百多个工具装不下

绑账号不绑 Bot，工具数就随**安装数**线性涨，而不是随「这颗 Bot 需要什么」。算术很直白：
Gmail 29 个工具（截图），装 8 个连接器、其中两个连了两个账号 = 两百多个工具，每一颗 Bot
的 system prompt 里都躺着。上下文先炸，模型选工具的准确率也垮。

三条防线，按顺序：

1. **员工自己关。** 截图里的「29 of 29 enabled」就是这个开关。装 Gmail 只为发通知的人，
   关到剩两个。**这是首选路径，界面上要好按**——防线一好用，后面两条就基本用不上。
   前提是**装上别默认全开**：上架时填 `recommendedTools`，安装时写进去（tool-search.md §2）。
   默认全开的话这条防线等于没有——GitHub 五百个工具，员工要点四百多次才关得完
2. **硬上限** `CONNECTOR_MAX_TOOLS`（默认 64，**按一把连接算**——Gateway 的 MCP 端点
   一次只看得见一把连接，看不到这颗 Bot 一共挂了几把）。超了在 `tools/list` 里截断，
   **并且说出来**：响应里带 `truncated`、日志里一行、详情页一条红字（「开了 N 个，超过
   上限 M 个，多出来的不会下发」）。静悄悄截断会变成「某个工具时有时无」，最难查
3. **退化成元工具**：超限时该连接只出 `search(query)` / `describe(tool)` /
   `execute(tool, args)` 三个。执行规范在 [tool-search.md](./tool-search.md)——那一份把档位、
   元工具契约、计费口径和缓存影响定死了，并且给防线一补了一条「安装时别默认全开」

排序上有个诱惑要顶住：给 Bot 加一个「这颗 Bot 用哪几个连接器」的开关，问题立刻没了。
但那就是把绑定偷偷加回 Bot 上，产品形态是员工装一次到处能用。真到了防线一二都压不住
的那天，再谈这件事，不要现在就埋一个半绑定。

---

## 8. 计费

### 一次「call」是什么

**一次 `tools/call` = 一个计费事件。** `tools/list`、`initialize`、授权流程都不计费——它们
不产生供应商侧的执行。

结果分四种，只有前两种收钱：

| 情况 | 记流水 | 收钱 | 为什么 |
|---|---|---|---|
| 上游 2xx，工具成功 | ✅ | ✅ | 正常 |
| 上游 2xx，工具自己说失败（如「邮箱不存在」） | ✅ | ✅ | 上游真的跑了一遍，成本已经发生 |
| 超时（45 秒没回来） | ✅ `timeout` | ✅ | **发出去的邮件不会因为我们没等到响应就退回来。** 这一档最容易被写成不收钱，但那等于给「超时的写操作」免单，而它照样发生了 |
| 我们自己拒掉（余额不足、工具不在子集、没授权、连不上供应商） | ✅ `denied` / `error` | ❌ | 没有产生任何上游成本 |

**provider 的 `execute` 不许把异常吞成返回值。** 吞掉之后上层就分不出「超时」和「参数
写错了」——而超时要收钱、参数错不收，判定超时靠的是调用方手里那个 AbortSignal，不是
错误文案。契约是两条路：**返回**（哪怕 `ok: false`）= 上游 2xx，跑过一遍，计费；
**抛出** = 没跑成，不计费（超时那一档由调用方按信号补上）。

**不自动重试。** 连接器里一半是写操作，重放一次就是多发一封邮件。上游 5xx 直接原样告诉
模型，让它自己决定要不要再来一次——那时是新的一次调用，新的一次计费。

### 单价

存在平台设置里（`platform_settings`），不另开表：

```jsonc
{
  "connectorPricing": {
    "defaultMicros": 2000,                    // 每次调用 0.002 美元
    "byToolkit": { "gmail": 1000, "jira": 3000 }
  }
}
```

单位是**微元**（百万分之一美元）整数，不是现有的厘（`amountMils`）。因为一次调用值
半厘、三分之一厘是完全正常的定价，用厘存会被舍成 0——一整年的调用加起来收零块钱。
两个单位并存不好看，但比「静悄悄免费」好；换算只有一处：`1 mil = 1000 micros`。

**这里没有 `priceMultiplier`。** 模型那边有倍率，是因为模型有「原价」（pi-ai 目录里的
每百万 token 多少钱），我们在原价上加成。连接器没有原价可加成——Composio 收我们的是
按席位按月的订阅，不是按次。硬套一个倍率只会让人以为存在一个不存在的成本基准。所以这里
直接定「一次多少钱」，怎么定是商务的事。

### 余额与拦截

> **这一节的口径已经被 [docs/billing.md](billing.md) 接管。** 下面这套公式一字没变，
> 但它现在算的是**三条计费路的总花费**（模型、连接器、网页工具），底表也换成了账本
> `usage_charges`——`connector_calls` 上那两个金额列只剩老行还有值。理由很简单：
> 一家公司把钱全烧在模型上时，只看连接器那张表算出来的余额纹丝不动。
> 实现在 `gateway/src/lib/meter.ts`，`routes/mcp.ts` 里那份 `budgetOf` 已经没了。

连接器是**第一个真的往下扣的东西**，所以口径最早在这里定死：

```
赠送还剩 = max(0, planBonusMils × 1000 − sum(bonusMicros where createdAt ≥ 本账期起点))
充值还剩 = max(0, topupMils   × 1000 − sum(amountMicros − bonusMicros))   // 全部历史
可用余额 = 赠送还剩 + 充值还剩
```

**两个桶必须分开记，流水行上要留下这一笔吃了哪个桶**（现在是 `usage_charges.bonusMicros`，
迁移 0005 时是 `connector_calls.bonusMicros`）。
合成一个「(赠送+充值) − 全部历史花费」的数看着更简单，但它在套餐到期那一刻就错了：
赠送归零，而它**已经花掉的部分仍然留在花费里**，等于从充值余额上再扣一遍。一月送 $10
花掉 $10，二月套餐过期后充 $5，算出来是 −$5——刚付过钱的公司当场被判欠费。

**不建余额行。** 余额永远是「充的 − 花的」现算，和现在 `balanceOf` 的风格一致。建一行
余额就要为每次工具调用去更新它，一家公司所有席位挤在同一行上排队，为一次 20 毫秒的调用
付出一次行锁——不值得。

扣费顺序：**先扣套餐赠送，再扣充值。** 赠送跟着套餐到期作废，充值不过期；反过来扣，等于
逼着公司把不过期的先花光，然后眼看赠送额度过期。

余额 ≤ 0：`tools/call` 返回**一句人话**（"这家公司的额度用完了，请联系管理员充值"），
不是 HTTP 5xx。Bot 侧 `registerMcpTool` 会把它当成工具输出交给模型
（`bot/src/catalog/index.ts:446`），模型会照实告诉用户；返回错误的话，模型多半会重试三次
再放弃。

**允许小额透支。** 并发的几十次调用会同时读到同一个「还有余额」，不加锁就会超一点。
超的上限是一轮并发的量，几分钱。为这几分钱去锁公司余额，代价是所有席位串行。

---

## 9. 统计

三个接口，三个范围，沿用 `/platform/stats` 的既有约定：时间窗由前端算好 `from` / `to`
（unix 毫秒）传进来——「今天」是相对**用户所在时区**的，服务端自己切会错一整天。

| 接口 | 谁 | 维度 |
|---|---|---|
| `GET /platform/connector-stats` | `owner` | 公司 × 连接器 × 工具；次数、成功率、金额、P95 耗时 |
| `GET /orgs/:id/connector-stats` | `admin` | 员工 × 连接器；次数、成功率、金额。**外带一份「谁装了什么」**——自助安装之下，这是他唯一能看清攻击面的地方 |
| `GET /me/connector-stats` | 员工 | 自己的：连接器 × 账号（label）× 工具、次数 |

金额在流水行上就是算好的整数微元（`amountMicros`），统计只 `sum`。**不在统计时按当前
单价现算**——单价改过之后，历史账会跟着一起变，上个月的账单每天都不一样。这是和模型
统计有意的不同：那边是按 token 数乘当前单价现折，因为模型单价是外部给的、我们没有
「成交价」这个概念；连接器的单价是我们自己定的，定的那一刻就该固化。

行数上去之后（经验阈值：单表过千万）加一张按 (公司, 连接器, 日) 的汇总表，
统计和余额都改成「汇总表 + 当天的原始行」。**v1 不做**，但流水表的列现在就按能汇总来设计。

---

## 10. 数据模型

一条迁移 `0004-connectors.ts`，只干结构这一件事（`docs` 里那条规矩：一条迁移一件事）。

```sql
-- kind 的 check 加一个值，照 0002 的写法按定义找出约束名再换
alter table catalog_items ... check (kind in (..., 'connector'));

-- 员工装了什么，以及开了哪几个工具。装了不等于能用，能不能用看下面那张表。
create table if not exists connector_installs (
  id              text primary key,
  "connectorId"   text not null references catalog_items(id) on delete cascade,
  "accountId"     text not null references accounts(id) on delete cascade,
  "companyId"     text not null references companies(id) on delete cascade,
  -- 空数组 = 全开。存开着的那些而不是关掉的那些：上游加了新工具，默认是不给的，
  -- 员工没点过头的东西不该因为供应商发版就自己出现在他的 Bot 里。
  "enabledTools"  jsonb not null default '[]',
  "createdAt"     bigint not null,
  "updatedAt"     bigint not null
);
create unique index if not exists install_one on connector_installs ("connectorId","accountId");

-- 一把授权 = 一个外部账号。一个安装可以有好几把（default / personal / company）。
create table if not exists connector_connections (
  id                 text primary key,
  "connectorId"      text not null references catalog_items(id) on delete cascade,
  vendor             text not null,
  scope              text not null check (scope in ('user','company')),
  label              text not null,   -- 员工起的名字，进工具名前缀，[a-z0-9_-]{1,16}
  "accountId"        text references accounts(id) on delete cascade,
  "companyId"        text not null references companies(id) on delete cascade,
  "externalUserId"   text not null,   -- sw_{accountId} / swc_{companyId}
  "externalId"       text,            -- 供应商侧的 connected account id
  status             text not null check (status in ('pending','active','failed','revoked')),
  -- 打开 = 这把连接不进默认工具表，只有本轮被 @ 点名才注入。个人邮箱这类用它。
  "mentionOnly"      boolean not null default false,
  "lastError"        text,
  "connectedAt"      bigint,
  "createdAt"        bigint not null,
  "updatedAt"        bigint not null
);
-- 同一个人在同一个连接器下，label 不能重——它是工具名的一部分，重了模型就选不动。
create unique index if not exists conn_user on connector_connections ("connectorId","accountId",label)
  where scope = 'user';
create unique index if not exists conn_company on connector_connections ("connectorId","companyId",label)
  where scope = 'company';

create table if not exists connector_calls (
  id             text primary key,
  "companyId"    text,                -- null = owner 自己发起的（和 llm_calls 一致）
  "accountId"    text not null,
  "connectionId" text,                -- 哪一把连接。多账号时「是哪个邮箱发的」靠它
  -- 这一轮用户 @ 点名了这把连接。出事时第一个问题是「人点的还是 agent 自己决定的」，
  -- 事后从会话正文里去反推既慢又不一定对得上，一列布尔换掉那件事。
  "viaMention"   boolean not null default false,
  "botId"        text,                -- 只做归因，可能是席位自报的
  "sessionId"    text,
  vendor         text not null,
  connector      text not null,       -- toolkit slug，存字面量不存外键
  label          text not null default '',
  tool           text not null,
  status         text not null check (status in ('ok','failed','timeout','denied','error')),
  "amountMicros" bigint not null default 0,
  "latencyMs"    integer not null default 0,
  "createdAt"    bigint not null
);
create index if not exists calls_company_time on connector_calls ("companyId","createdAt");
create index if not exists calls_account_time on connector_calls ("accountId","createdAt");
```

`connector` / `label` / `tool` 存**字面量**而不是外键：连接断了、连接器下架之后，「上个月
谁烧了多少」还得查得到。`llm_calls` 里 `provider` / `model` 是同一个处理
（`gateway/src/db.ts:490` 的注释）。

**排队的消息不进这张库，也不进 Gateway。** 它在实例的 `satuwork.db` 里（一行：
`sessionId` / `text` / `images` / `mentions` / `createdAt`），跟着那台机器走。Gateway 存
的是会话**指针**，一条还没发生的消息连指针都算不上。

`connector_connections` 上**不存 access token**。令牌在供应商那边，我们只存一个引用
（`externalId`）。这是选 Composio 这类供应商最实际的一条好处，别自己把它抵消掉。

---

## 11. 接口契约

### 平台（`owner`）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET/PUT | `/platform/connector-vendors` | 配供应商密钥（写进 `platform_credentials`）、看连通性 |
| GET | `/platform/connector-toolkits` | 供应商那边有哪些可上架（`provider.listToolkits`） |
| GET | `/platform/connector-toolkits/:slug/tools` | 某个连接器的工具表，看清楚再上架 |
| CRUD | `/platform/connectors` | 市场上架 / 下架 |
| GET/PUT | `/platform/settings` | 加 `connectorPricing` 一段 |
| GET | `/platform/connector-stats` | 平台统计 |

### 公司（`admin`）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/orgs/:id/connectors` | 市场清单 + 本公司禁令 + 本公司装机量 |
| PUT | `/orgs/:id/connectors/:connectorId/block` | 禁用 / 解禁（带原因）。**不是**启用开关 |
| POST | `/orgs/:id/connectors/:connectorId/connections` | 连一把公司共用的 |
| DELETE | `/orgs/:id/connectors/:connectorId/connections/:connectionId` | 断掉公司那把 |
| GET | `/orgs/:id/connector-stats` | 公司统计：谁装了、谁在用、花了多少 |

### 员工

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/me/connectors` | 市场（含已装标记、禁用标记）+ 我的安装与连接 |
| GET | `/me/connectors/:id` | 详情：我的账号列表、工具开关、状态 |
| POST | `/me/connectors/:id/install` | 安装。不碰供应商，立刻返回 |
| DELETE | `/me/connectors/:id/install` | 卸载，连带断开我在它下面的所有连接 |
| PUT | `/me/connectors/:id/tools` | `{ enabledTools: string[] }`，空数组 = 全开 |
| POST | `/me/connectors/:id/connections` | `{ label }` → 返回 `redirectUrl` |
| PATCH | `/me/connectors/:id/connections/:connectionId` | 改 `label` / `mentionOnly` |
| DELETE | `/me/connectors/:id/connections/:connectionId` | 断开这一把 |
| GET | `/mentions?q=` | `@` 选单的候选：连接（本文）+ Bot + Routine（另文）。一个接口，前端不拼三份 |
| GET | `/oauth/connectors/callback` | 供应商回调。**不信参数**，回头查 `provider.status` |
| GET | `/me/connector-stats` | 我的用量 |

**员工侧的接口一律在 `/me/connectors/*` 下面，不在 `/connectors/*`。** 后者是**浏览器的
页面地址**（`/connectors` 是市场，`/connectors/:id` 是详情）。两边撞在一起的话，路由器
先中的是 API——人在地址栏敲 `/connectors` 会拿到一坨 JSON 而不是界面。回调同理挪到
`/oauth/` 下面，免得将来和详情页的 `:id` 抢同一段。

### 席位（`sat_`）

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/mcp/connectors/:connectionId` | MCP over HTTP：`initialize` / `tools/list` / `tools/call` |
| POST | `/mcp/connectors/:connectionId/files` | 附件要上传位：body `{ tool, name, mimetype, md5, size }`，回 `{ file, upload }`，字节由席位自己 PUT 到 `upload.url`。门同上，不计费（§7「附件」） |

### 实例（Gateway 反代过去，浏览器不直连）

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/sessions/:id/messages` | 已有。body 加 `mentions`，响应加 `{ queued, queueId }` |
| GET | `/api/sessions/:id/queue` | 当前队列快照。刷新后恢复 dock 用 |
| DELETE | `/api/sessions/:id/queue/:queueId` | 取消一条。已经开跑 → 409 |

`/runtime/catalog` 的 `servers` 数组里多出合成条目，`stamp` 的算法多两个输入。响应形状
不变——Bot 那边不用改协议。

发消息那条（Gateway 反代到席位）body 多一个 `mentions: [{ kind, id, label }]`。Gateway
先校验再透传（§7），席位把它写进 `user/message` 的内容块并用于这一轮的工具表；正在跑
且校验后仍有 mention 的，入队并回 `{ queued: true, queueId }`。

---

## 12. 界面

菜单加一项 `/connectors`（`gateway/ui/prefs.js` 的三份导航各加一行；同时要进
`gateway/src/http.ts:97` 的 `SPA_PATHS`，否则刷新页面 404）。**员工侧栏现在是空的**
（`MEMBER_NAV = []`，只有 Bot 名单），连接器是第一个要进去的东西——入口可以像截图那样
放在侧栏底部，和头像并排。

- **owner**：供应商密钥、连通性、市场上架（从供应商现拉 toolkit 列表）、单价、平台统计
- **admin**：市场清单 + 禁用开关（带原因）、公司共用的连接、本公司谁装了什么、花了多少
- **member**：两个页面
  - 市场：分组卡片，每张一个「安装 / 已安装」按钮，被公司禁的灰着并写明原因
  - 详情：账号列表（每行一个 label + 状态 + 「仅 `@` 时可用」开关 + 断开）、
    「添加账号」、工具开关（`n of m enabled`，展开是勾选列表）

### 员工的入口是「插件」，不是菜单里那一行

侧栏 Bot 名单底下、「新建 Bot」下面一颗**「插件」**按钮（`render.js` 的 `appView`），
点开是弹窗 `pluginsModal()`（`pages-connectors.js`），不跳页：

- 市场 / 已安装两个页签 + 搜索；每行一颗「添加」（未装）或「管理」（已装）
- 「添加」= 安装，装完**留在同一个弹窗里**，直接翻到详情连账号、挑工具
- 用的是和详情页同一套零件（`connectionRow` / `connectorToolsBox`），不另画一份

**为什么不是菜单里一行。** 装插件是**为了把话说完**才做的事——「让它读一下我的邮件」
说到一半才发现 Gmail 没装。跳走一整页，回来时草稿、滚动位置、刚选好的那颗 Bot 全没了。
所以 `MEMBER_NAV` 又空了（同一件事留两个并排的入口，只会让人问这两个有什么不一样），
但**页面没有撤**：`/connectors` 和 `/connectors/:id` 还在，OAuth 回调就落在那儿
（§6 那个 302），所以 `allowedHrefs()` 里给非 owner 单独放行了 `/connectors`。

弹窗的详情存在 `state.pluginDetail`，**和页面那份 `state.connectorDetail` 分开**：
弹窗能盖在 `/connectors/:id` 上面，共用一个字段的话，在弹窗里翻了别的插件，关掉之后
底下那页画的是别人的账号。同理，`conn-label` / `conn-tool` 这些控件两边同名，读值要
限定在弹窗里（`connRoot()`），不然取到的是底下那页那一份。

聊天那一侧（`gateway/ui/chat.js`）四件事：输入框打 `@` 弹选单（走 `/mentions`）、
选中后在输入框里渲染成药丸、发送时把 `mentions` 一起带上、以及**排队 dock**。历史消息
里的 `mention` 块也要渲染成同样的药丸，否则翻上去看昨天那条，点名就消失了。

### 排队 dock

点了发送、后端回 `queued` 之后：输入框清空，这条话变成**输入框顶上的一行小字**。

- **一条一行**，纯文字，超出省略号。**不展开附件**——图片不出缩略图，`@` 出来的药丸也
  不画。dock 是「等会儿要说的话」的一个提醒，不是消息气泡的预演；把气泡的全套渲染搬上
  去，输入框会被顶掉半屏
- 行尾一个 `×`，随时取消。取消撞上「已经开跑」→ 那一行原地变成正常气泡（§7）
- **多条就多行**，最多显示 3 行，再多第一行变成「还有 N 条」。「只占一行」约束的是
  **一条消息不许展开成多行**，不是队列只能有一条——排了一条之后想再排一条只能干等，
  比多一行烦得多
- 刷新页面从 `GET /api/sessions/:id/queue` 恢复。**这一条不能省**：dock 是浏览器画的，
  队列是实例存的，不对齐就会出现「界面上没有但它还是跑了」

三种角色共用一份页面骨架，按角色换接口前缀——`/skills` 现在就是这么做的
（`catalogBase()`）。

新分片 `pages-connectors.js`：`gateway/src/http.ts` 的 `UI_PARTS` 和
`gateway/ui/index.html` 的 `data-app-part` **两处都要加**，少一处线上 404 而本地是好的。

---

## 13. 审计

进 `audit_events` 的（都是「谁改了权限边界」）：

- `connector.publish` / `connector.unpublish`（平台市场上架、下架）
- `connector.block` / `connector.unblock`（公司禁用某个连接器，带原因）
- `connector.install` / `connector.uninstall`（谁装了什么）
- `connector.connect` / `connector.disconnect`（谁授权了哪个账号，公司共用那把另记发起人）
- `connector.connection.update`（改了 `mentionOnly`——它决定这把连接会不会被隐式调用，
  是权限边界，不是显示偏好）
- `connector.pricing.update`

**安装和卸载要记。** 它看着像个人偏好，但它是「这个人从今天起能把公司数据发到哪儿」的
起点——出事时第一个要查的就是这一行。工具开关（`n of m enabled`）不记：一天点十几次，
而它只会让权限变小或变回默认。

**工具调用不进审计。** 一天几万次，会把审计表淹掉，而它们已经在 `connector_calls` 里了。
审计回答的是「谁改了什么」，用量回答的是「谁用了多少」，两张表两个问题。

---

## 14. 新增的不变量

接在 `gateway-runtime.md` §15 那一串后面：

16. 供应商 API key 只在 Gateway。不进浏览器、不进用户 JWT、不进 Bot 的环境和磁盘、不出现在
    `/runtime/catalog` 的响应里
17. 每一次外部工具调用都经过 Gateway，且都落一行 `connector_calls`——包括被拒掉的
18. `/mcp/connectors/*` 只认席位 `sat_`；登录 JWT 和 `sk_sw_` 一律 401
19. 一把连接只有它的主人（或同公司的人，`scope='company'` 时）用得动。工具能不能调，看
    「连接归属 ∩ 连接 active ∩ 公司没禁 ∩ 工具在员工开着的子集里」。URL 上的 `botId`
    只做统计归因
20. 一个账号装了什么，他名下**所有** Bot 都看得见——没有「只给某颗 Bot 用」这种状态
21. `@` 只放大可见性，不突破归属：点名一把不属于自己的连接，Gateway 在反代时剔掉，
    不是报错也不是照传
22. 排队的消息只在实例的 `satuwork.db` 里，不进 JSONL、不进 Gateway。它跑起来的那一刻
    才是一条 `user/message`；取消掉的，任何地方都不留正文
23. 单价改动不影响已经落地的流水金额
24. 附件上传位（`/mcp/connectors/*/files`）过的门和 `tools/call` 一道不少，但**不是执行**：不计费、
    不落 `connector_calls`。字节**不经 Gateway**：席位直接 PUT 到供应商的预签名地址，那条地址
    不带供应商密钥

---

## 15. 里程碑

**M1 — provider 层与市场**
`connectors/{types,composio,index}.ts`；owner 配密钥、拉 toolkits、上架；迁移 `0004`。
验收：owner 那一屏能列出 Composio 的 toolkit 真实清单，上架的能在员工市场里看到。

**M2 — 安装、授权、多账号**
`connector_installs` + `connector_connections`、员工两屏（市场 / 详情）、`install` /
`connect` / `callback` / `disconnect`、公司禁用、审计。
验收：员工装上 Gmail 并连两个邮箱，界面上并排两行都是「已连接」；断开一个，另一个不受
影响；admin 把它禁掉，员工那边立刻灰掉并写出原因。

**M3 — 工具下发**
`/mcp/connectors/:connectionId`、合成的 MCP 记录（一把连接一条）、`stamp` 加输入、
`McpHttpClient` 的超时参数、工具开关与上限。
验收：在对话里说「用个人邮箱给张三发封邮件」，发出去的是 `personal` 那个账号；换一颗
Bot 聊天不用重装重连；Bot 的环境变量里搜不到任何 Composio 相关的东西。

**M4 — 计费与统计**
`connector_calls`、单价、余额拦截、三个统计接口和界面。
验收：调用十次，平台统计里这家公司正好十次、金额对得上；把余额调成 0，第十一次在对话里
得到一句人话而不是一个错误堆栈。

**M5 — `@` 点名与排队**（可与 M4 并行，动的文件不重叠）
会话格式升到 v5（加 `mention` 块，无需迁移代码）、`/mentions`、Gateway 侧校验、
`toolSchemasFor` 收 mentions、截断例外、`mentionOnly`、消息队列（`satuwork.db` + SSE +
取消）、chat UI 的选单、药丸与 dock。
验收：`@Gmail (personal)` 加一句「查看最新邮件」，读的是 personal 那把；把 personal 设成
「仅 `@` 时」之后，不点名地说「看看我的邮件」，它不会被碰；翻回昨天那条消息，药丸还在；
上一轮还在跑时发一条带 `@` 的，它压在输入框顶上一行，刷新页面还在，这一轮结束后自己
接上；在它刚开跑的那一刻点取消，得到的是「已经开始执行」而不是没反应。

---

## 16. 明说的取舍与风险

- **一把平台 key，爆炸半径是全平台。** Composio 的 API key 能操作所有用户的所有连接。
  它只在 Gateway，但 Gateway 被拿下就是全部。缓解：这把 key 和模型密钥一样只出现在
  `platform_credentials`，不进日志（`redact`）、不回显；轮换要能一分钟内完成
- **供应商 lock-in 在工具名上。** provider 层挡得住 API 形状的差异，挡不住
  `GMAIL_SEND_EMAIL` 这个名字——它会进历史会话的 JSONL。换供应商时老会话里的工具名
  就成了考古记录。接受，但流水表按 `vendor` 分列存，别把它们混成一个串
- **数据出境。** 邮件正文、CRM 记录会经过 Composio 的服务器。哪些连接器上架由 owner
  决定，公司还能再禁，这两层控制是有的；但这件事必须写进给客户的说明里，不能默认没人问
- **自助安装把控制点往员工那边挪了一格。** 原来是「管理员开了才有」，现在是「上架了就
  能装，除非公司禁」。默认放行是产品形态要的，但它意味着：合规的把关落在**上架**这一步
  （owner）和**禁用**这一步（admin），而不是每一次安装。所以 admin 那一屏必须能一眼看到
  「本公司谁装了什么」，否则他连该禁什么都不知道
- **员工自己装、烧的是公司的钱。** 余额是公司的，安装是个人的。v1 靠公司总余额兜底
  （§8 的 402），没有人均限额。真出现「一个人一天烧掉一个月预算」的情况，再加
  `perAccountDailyMicros`——形状不用变，就是在拦截那一步多查一个 sum
- **公司共用的那把连接谁都能用。** `connector_calls` 里记的是发起人，能查到是谁发的，
  但拦不住。这是设计如此，不是漏洞，admin 那一屏要说清楚
- **隐式调用是默认的，而它会碰到所有连着的账号。** 截图里一句「查看我的邮件」就读了两个
  邮箱。这是产品要的（不然每次都得点名，体验就废了），代价是「我没让它读的它也读了」。
  `mentionOnly` 是给这件事的出口，但它默认是关的——默认值站在好用那一边，所以第一次连
  个人账号时界面要主动问一句
- **超时那一档收钱会被投诉。** 理由（§8）站得住，但要在计费说明里写明白，别等到对账时
  才第一次解释
