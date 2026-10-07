# Satuwork：工具搜索（Tool Search）

连接器的工具多到装不下时，那一把连接不再下发它的全部工具，改为下发三个元工具，让模型
**先搜、再看、才调**。

本文是 [connectors.md](./connectors.md) §7「两百多个工具装不下」里**防线三**的执行规范。
那一节定了「退化成元工具 `search` / `describe` / `execute`」这个方向，本文把它定死：降到
第几档、元工具长什么样、钱怎么算、缓存怎么算、搜不到时说什么。

和 connectors.md 冲突处以 connectors.md 为准；本文只在它的 §7、§8 上**加一档行为**，不改
计费口径，不改 `@` 点名，不改绑定模型。

---

## 1. 目标与非目标

**做成：**

1. 一把连接开着的工具超过 `CONNECTOR_MAX_TOOLS` 时，`tools/list` 不再截断，改为下发
   `SW_SEARCH` / `SW_DESCRIBE` / `SW_RUN` 三个元工具
2. **降级不是截断**：降级之后，这把连接上每一个开着的工具**都够得着**，一个都不少
3. 按上下文预算分三档（§4）：装得下就全量、装不下清单就只留摘要，中间那一档保留
   「名字 + 一句话」的清单
4. 元工具走 Gateway 现有的那条路：白名单、toolkit 边界、超时、流水、计费，一样不少
5. 对 Bot **零改动**——降级发生在 `tools/list` 的响应里，席位那边看到的仍然是普通 MCP 工具
6. 对提示缓存**零代价**（§6）

**先不做：**

- **供应商侧搜索。** `ProviderCaps.search` 那一位先不用。v1 在已经缓存的工具清单上本地搜，
  不打上游——零延迟、零成本、不产生「搜索算不算一次调用」的争论。真到了某个 toolkit 连
  清单都拉不动的那天再说
- **点名免于降级。** connectors.md §7 有一条「被点名的连接免于截断」。降级之后那条的前提
  没了（没有工具被丢掉），而让 Gateway 知道「这一轮有没有点我」要给 `tools/list` 加参数、
  要改 Bot。收益不值这个改动
- **跨连接的全局预算。** Gateway 的 MCP 端点一次只看得见一把连接，看不到这颗 Bot 一共挂了
  几把。八把连接各出 3 个元工具是 24 个，够用了。真正的全局分档要做到 Bot 侧，是另一份文档
- **Anthropic / OpenAI 原生 `defer_loading`。** 见 §11，将来的加速档，不是主线

---

## 2. 先改一件更便宜的事：安装不要默认全开

截图里那个「500 / 500 个已开启」不是员工点出来的，是默认态：`installConnector` 写的是
`enabledTools: []`（[db.ts:847](../gateway/src/db.ts:847)），而 `tools/list` 把空数组读成
「全开」（[mcp.ts:171](../gateway/src/routes/mcp.ts:171)）。

也就是说 connectors.md 的**防线一「员工自己关」被这个默认值架空了**——它假设员工会去关，
但默认全开的界面上，员工要点 485 次才能剩下 15 个。

改法，两条，都很小：

1. 上架记录里加 `recommendedTools: string[]`，owner 上架时填。GitHub 挑十几个，Gmail 挑五个
2. `installConnector` 时把这份推荐集写进 `enabledTools`，**而不是留空**

**`[]` = 全开这个口径不动。** 已经装好的那些存的就是 `[]`，改口径等于让现存用户的工具悄悄
少掉一批——正是这份文档里到处在防的那类事。改的只是「新装的时候写什么进去」。

owner 没填推荐集就还是留空（全开），由本文的降级兜底。**两条防线是叠的，不是二选一。**

---

## 3. 为什么降级做在 Gateway，不做在 Bot

三个理由，按份量排：

1. **不挑 provider。** 默认 provider 是 deepseek，走的是 `openai-completions`。做在 Bot 侧
   （或用原生 `defer_loading`）都要看模型 API 支不支持；做在 Gateway 侧，元工具就是三个普通
   MCP 工具，哪家模型都认
2. **对提示缓存零代价。** 详见 §6。Bot 看到的工具数组恒定是三个，缓存前缀纹丝不动
3. **边界已经在那儿了。** `tools/call` 上的白名单、toolkit 边界、超时、流水、计费全在
   [routes/mcp.ts](../gateway/src/routes/mcp.ts) 这一个文件里。`SW_RUN` 落在同一个函数里，
   共用同一套判定，不用把这些规则在 Bot 侧再实现一遍——**再实现一遍就一定会分叉**

代价也说清楚：Gateway 看不见「这颗 Bot 一共挂了几把连接」，所以它只能按**单把连接**判断该不该
降级。这是 `CONNECTOR_MAX_TOOLS` 的注释里已经写下的局限，本文不改它。

---

## 4. 三档

每次 `tools/list` 重新算，不缓存档位。设开着的工具有 `n` 个、清单文本估算 `L` token：

| 档 | 条件 | 下发什么 |
|---|---|---|
| **0** | `n ≤ CONNECTOR_MAX_TOOLS` | 全量工具。**今天的行为，一个字不改** |
| **1** | 超了，但 `L ≤ CONNECTOR_LISTING_MAX_TOKENS` | 三个元工具，`SW_SEARCH` 的 description 里嵌完整清单（`SLUG — 一句话`，每行一个） |
| **2** | `L` 也超了 | 三个元工具，description 里只有一行摘要：「GitHub，共 500 个工具，用 SW_SEARCH 找」 |

**第 1 档是关键的一档，不能省。** 有清单在，模型是在**认**工具；没清单，模型是在**猜**查询词。
默认 provider 是小模型，这两件事的成功率差得远。

`L` 用 `Math.ceil(chars / 3)` 粗估，不引 tokenizer：这里只要「塞不塞得下」的量级判断，为它多
一个依赖、还得跟着模型走，不值。

按这个表：Gmail 29 个 → 第 0 档，什么都没变。GitHub 500 个 → 清单本身两万字上下 → 第 2 档。

---

## 5. 元工具的契约

### 名字

`SW_SEARCH` / `SW_DESCRIBE` / `SW_RUN`。

`SW_` 前缀是我们的命名空间，为的是**不跟供应商的真工具撞**。Composio 的 GitHub 里就有一堆
`GITHUB_SEARCH_*`，而 `resolveToolSlug` 会给不带前缀的名字**无条件补 toolkit 前缀**
（[mcp.ts:56](../gateway/src/routes/mcp.ts:56)）——`SEARCH` 会被还原成 `GITHUB_SEARCH`，
调到一个真实存在的、完全不相干的工具上去。

**所以有一条硬规矩：`tools/call` 必须在 `resolveToolSlug` 之前按 `SW_` 前缀拦截。** 顺序反了
就是一个能跑通、结果全错、日志上还看不出来的 bug。

席位那边合成出来是 `mcp_github_defaul_sw_search`，在 64 字的名字上限内。

### `SW_SEARCH(query, limit?)`

在这把连接开着的工具里搜。**本地搜**，数据来自 `toolsOf()` 那份五分钟缓存，不打上游。

- 匹配：对 `slug` + `name` + `description` 做大小写不敏感的分词匹配，命中 slug 权重最高
- `limit` 默认 `CONNECTOR_SEARCH_LIMIT`（5），硬上限 `CONNECTOR_SEARCH_MAX_LIMIT`（20）
- 返回每条 `slug` + 一句话描述，**不返回 schema**——要 schema 去 `SW_DESCRIBE`

**搜不到时不许回空数组。** 回一句人话：

> 「github 这把连接有 500 个工具，"发工资" 没有命中任何一个。换几个英文关键词试试，
> 比如 issue / pull request / workflow。」

理由跟 connectors.md 里反复写的那条一样：静默的空结果在模型眼里等于「这个工具不存在」，
它会转头告诉用户做不到。**这是静默截断换了个马甲，要在同一个地方掐掉。**

### `SW_DESCRIBE(tool)`

返回一个工具的完整 `inputSchema`。同样走那份缓存，不打上游。

`tool` 过 `resolveToolSlug` 还原，再过 `enabledTools` 白名单。**关掉的工具描述不出来**——
否则模型会拿到一个它永远调不动的 schema，然后反复重试。

不在清单里的名字，回一句「这把连接里没有这个工具，先用 SW_SEARCH 找」，不回错。

返回前过一遍 `annotateFileParams()`：文件参数（`file_uploadable`）的说明里补上「先调
`connector_upload_file` 上传，再把句柄原样填这里」——和 `tools/list` 直出那一档同一句话
（connectors.md §7「附件」）。只改说明，不改形状。

### `SW_RUN(tool, args)`

真正的执行。**它就是今天的 `tools/call`，只是名字从参数里来。**

拦下 `SW_RUN` 之后，`tool` 过 `resolveToolSlug`，然后走**完全同一条**路径：白名单判定
（[mcp.ts:250](../gateway/src/routes/mcp.ts:250)）、`UPSTREAM_TIMEOUT_MS`、`insertConnectorCall`、
`meter.charge`。流水里的 `tool` 字段落**真实 slug**，不是 `SW_RUN`。

**这条是不变量，不是实现细节：** 元工具不许成为绕过工具开关的后门。员工关掉的工具，
`SW_RUN` 也调不动；跨 toolkit 更够不着。判定必须是同一段代码，不是抄一份。

---

## 6. 缓存这笔账

结论先放：**这套做法对提示缓存零代价，而且不做它才是一直在为缓存付钱。**

### 断点打在哪

你们在跑的 `@earendil-works/pi-ai@0.84.2` 打两个 `cache_control`：

- 一个在**最后一个 immediate 工具**上（`dist/api/anthropic-messages.js:1032`）→ 缓存前缀 = 整个 tools 块
- 一个在**最后一条 user / tool_result** 上（同文件 `:980`）→ 滚动缓存对话历史

**tools 块排在最前面。它一变，后面全作废。**

### 三种实现，三个结果

| 实现 | tools 数组 | 缓存后果 |
|---|---|---|
| **本文这套（Gateway 元工具）** | 恒定三个 | **不作废。** schema 以 tool_result 进 messages，只追加，下一轮就被滚动断点收进缓存 |
| pi-ai 原生 `defer_loading` | 会变 | 每个「首次真正被调用」的工具作废一次前缀 |
| 在 Bot 里搜到就 `ctx.tools.register` | 每搜必变 | **每次搜索都作废。这条要避开** |

第二行的依据在 `dist/utils/deferred-tools.js` 的 `splitDeferredTools`：被搜出来但还没调用的
工具算 deferred，排在断点**之后**，怎么churn 都不影响缓存；**一旦模型真调了它，它就升进
immediate、跑到断点前面**，前缀变了。一个会话真正用到 k 个工具就作废 k 次。

第三行是最直觉、也最贵的写法。写在这里就是为了别有人顺手这么写。

### 不做它才贵

今天 64 个工具的 schema（约 1.6 万 token）躺在缓存前缀里，看着是「命中率很高」，但它
**每一轮都在按 cacheRead 单价付一次**。缓存把它打了一折，没让它消失。二十轮的会话就是
三十多万个 cacheRead token。

降级之后每轮的工具块是三个元工具、几百 token。多花的是 `SW_DESCRIBE` 结果那一次性的全价
input（三五个工具、千把 token，下一轮也进缓存）。**第二轮就回本。**

这笔账落在 [lib/pricing.ts](../gateway/src/lib/pricing.ts) 已经分开的 `input / cacheRead /
cacheWrite` 三档上，上线后能直接从账本里读出来验证，不用估。

---

## 7. 钱怎么算

沿用 connectors.md §8 的口径，**一个字不改**：

- **`SW_RUN` = 一次 `tools/call` = 一个计费事件。** 跟直接调用完全一样，流水里 `tool` 落真实 slug
- **`SW_SEARCH` / `SW_DESCRIBE` 不计费，也不落 `connector_calls`。** 它们不产生供应商侧执行——
  跟 `tools/list`、`initialize` 同一档。落进流水表还会**污染「按工具统计次数」**：SEARCH 会
  变成这个 toolkit 里调用量最大的「工具」，统计那一屏当场失真
- 两者只写日志：一行 `连接 X 搜 "query" 命中 N 个`。排查时第一个要问的是「模型搜了什么、
  最后调了什么」，日志够回答

**成本转移要说出来：** 多的两轮往返不落在连接器这条线上，落在 **model token** 那条线上
（billing.md 的三条路之一）。降级模式下一次工具调用大约多两轮请求。这不是隐藏成本——账本里
看得见——但做容量规划的时候要记得它换了个口袋。

---

## 8. 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CONNECTOR_MAX_TOOLS` | 64 | **语义变了**：从「硬截断线」变成「降级线」 |
| `CONNECTOR_TOOL_SEARCH` | `auto` | `auto` 按 §4 分档；`on` 强制降级（评测用）；`off` 退回今天的截断行为 |
| `CONNECTOR_LISTING_MAX_TOKENS` | 4000 | 第 1 档和第 2 档的分界 |
| `CONNECTOR_SEARCH_LIMIT` | 5 | `SW_SEARCH` 默认返回条数 |
| `CONNECTOR_SEARCH_MAX_LIMIT` | 20 | 硬上限，模型传再大也压到这个数 |

`off` 那一档要**保留**现在的截断分支和 `truncated` 字段——它是降级出问题时的退路，退路不能
在同一次改动里一起删掉。

---

## 9. 界面

详情页那条红字（[pages-connectors.js:309](../gateway/ui/pages-connectors.js:309) 一带）语气要改：
现在说的是「多出来的不会下发」——一句警告；降级之后没有东西不下发了，它应该变成一句说明。

> 开了 500 个，超过 64 个。这个连接会切到**搜索模式**：Bot 先搜工具再调，全部 500 个都用得上，
> 代价是每次多一两轮往返。关掉用不上的能回到直连模式。

`GET /me/connectors/:connectorId` 的响应里加一个 `toolMode: 'direct' | 'listing' | 'search'`，
对应 §4 的三档。**界面不许自己按 `enabledCount > toolCap` 去推**——推的那一刻它就跟后端的
分档逻辑分叉了，而分叉的表现是界面说一套、Bot 拿到另一套。

---

## 10. 新增的不变量

接在 connectors.md §14 后面：

1. **降级不是截断。** 降级模式下这把连接开着的每一个工具都够得着。`truncated` 字段只在
   `CONNECTOR_TOOL_SEARCH=off` 时才可能出现
2. **`SW_` 前缀在 `resolveToolSlug` 之前拦截。** 顺序反了会调到真实存在的错工具上
3. **`SW_RUN` 和直接调用共用同一段判定代码。** 白名单、toolkit 边界、超时、流水、计费，
   不许抄第二份
4. **计费只认 `SW_RUN`。** `SW_SEARCH` / `SW_DESCRIBE` 不计费、不进 `connector_calls`
5. **搜不到要说话。** 空结果必须带一句可执行的建议，不许回空数组
6. **Bot 侧零改动。** 这一条一旦破了，说明方案跑偏了，回来重新看 §3
7. **「目录拉不到」和「清单里没有」是两件事。** `toolsOf` 抛出时 `SW_SEARCH` / `SW_DESCRIBE`
   要明说是目录取不到、并指路去 `SW_RUN`（那条路退回猜前缀，不依赖目录）。混成一个空数组
   的话，供应商抖一下模型就会告诉用户「这个能力不存在」
8. **`recommendedTools` 落库前必须拿真清单核过。** 它会原样写进新员工的 `enabledTools`，
   而 `tools/list` 是拿它精确过滤的——写错一个 slug 就是「连着、界面写着开了 N 个、
   一个工具都没有」。核不了（清单拉不到）就挡住这次保存，不放行
9. **开着的 slug 对不上清单时要说出来。** 供应商改名或下线一个工具也会走到这里。
   数字数「有几个是真的」，界面点名对不上的那几个，日志里一行
10. **`SW_RUN` 的参数要认平铺。** 模型经常把工具参数直接铺在 `arguments` 顶层；只认
    嵌套的 `args` 会把它变成一次空参数调用，而那一次**照收钱**（connectors.md §8）

---

## 11. 里程碑

1. ~~**Gateway 三件套 + 分档。**~~ 已落地：[lib/tool-search.ts](../gateway/src/lib/tool-search.ts)
   （纯函数：分档、估长、搜、渲染）+ [routes/mcp.ts](../gateway/src/routes/mcp.ts)（接进
   JSON-RPC、拦 `SW_` 前缀、复用同一条计费路径）。Bot 一行没动
2. ~~**界面：`toolMode` + 文案改写。**~~ 已落地：详情页返回 `toolMode`，红字只留给
   `off` 那一档真截断的情形，降级走 `gw-flash-note`
3. ~~**防线零（§2）：`recommendedTools` + 安装时写入。**~~ 已落地：上架弹窗里一格文本域，
   `installConnector` 收下它。`[]` = 全开的口径没动，已有安装不受影响
4. **评测。** 拿 GitHub 那 500 个，跑 deepseek / claude / gpt 三个模型，量「用户一句话 →
   调对工具」的命中率。**这一步不做就不算做完**，理由见 §12。要真模型密钥，还没做

`e2e/tool-search.mjs` 十二条覆盖 1–3：三档各一条、搜到 / 搜不到 / 描述 / 执行、`SW_RUN`
拦得住关掉的工具、`SW_SEARCH` 不落 `connector_calls`、推荐集不影响已有安装、两条界面。
跑法：`node e2e/run.mjs`（先 `docker compose up -d postgres`）

---

## 12. 明说的取舍与风险

1. **最大的风险是小模型搜不准。** hermes 那份文档自己就写了「需要模型生成合理搜索查询；
   小模型表现较差」，而你们默认 provider 是 deepseek。降级把「工具装不下」换成了「工具搜不着」，
   如果换得不划算，那是把一个看得见的问题换成一个看不见的问题。**所以里程碑 4 是验收条件，
   不是可选项。** 命中率不达标就把 `CONNECTOR_MAX_TOOLS` 调大、退回 `off`，先靠 §2 撑着
2. **多两轮往返。** 用户感知上是「慢了一拍」。第 1 档（带清单）能明显减少空搜，这也是它
   不能省的原因
3. **成本换了个口袋。** 连接器那条线不变，model token 那条线涨。见 §7
4. **Gateway 看不见全局。** 八把连接各降各的，加起来 24 个元工具。这是 §3 认下的局限
5. **将来的加速档：原生 `defer_loading`。** pi-ai 0.84.2 里全套都在了——`splitDeferredTools`、
   `addedToolNames`、`deferredToolsMode`、compat 上的 `supportsToolSearch`。缺的是我们自己那一跳：
   Bot 走 `/v1/chat/completions`，[v1.ts:304](../gateway/src/v1.ts:304) 组 `toolResult` 时没带
   `addedToolNames`，得在这个协议上加个字段。
   **但它只在 Anthropic / OpenAI Responses 上成立**，DeepSeek 那条路上直接退化成全量发。
   所以它是「用 Claude 的公司」的加速档，永远替代不了本文这一套
