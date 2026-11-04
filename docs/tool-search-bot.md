# Satuwork：Bot 侧工具搜索（Tool Search）

连接器和 MCP 的工具**默认不进发给模型的工具表**，换成三把桥接工具：先搜、再看、才调。

这份是 [tool-search.md](./tool-search.md) §1 里「跨连接的全局预算要做到 Bot 侧，是另一份文档」的那一份。
Gateway 那套单连接降级继续给老席位用（§9），新席位以这份为准。

设计对照了两家现成的做法：

- Hermes Agent 的 [Tool Search](https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/features/tool-search)
- OpenClaw 的 [Tool Search](https://docs.openclaw.ai/tools/tool-search/)

---

## 0. 为什么要做：2026-11-04 那次事故

一个员工连了 4 个 Google Drive（各 50 把）、Sheets、Docs、Slides、2 个 Gmail。每一把连接都没超过
`CONNECTOR_MAX_TOOLS`（64），Gateway 一把都没降级，于是工具表是 **364 把**：内置 40、连接器 324，
连接器那一段描述 150 KB，是系统提示词的四十倍。之后两颗 Bot 每句话都没回音。

问题不在某一把连接，在**加起来**。Gateway 一次只看得见一把连接，看不到总量，所以这件事只能在
Bot 侧做。

---

## 1. 两家怎么做的，我们取哪一边

两家骨架一样：客户端实现、不依赖供应商原生能力、三把桥接工具、本地 BM25、真实调用照样过审批和钩子。
差别在细节上：

| 点 | Hermes | OpenClaw | 我们取 |
|---|---|---|---|
| 桥接工具 | `tool_search` / `tool_describe` / `tool_call` | `tool_search` / `tool_describe` / `dispatch_action` | Hermes 的名字，好懂 |
| 什么时候开 | 有延迟工具就开 | 默认开，文档自己说小目录可能更贵 | **按量开**：连接器工具少时照旧全量（§3 第 0 档） |
| 清单放哪 | `tool_search` 的描述里 | 系统提示词的缓存边界之上 | **工具描述里**。连接器的描述是第三方写的，不进系统提示词（同 OpenClaw 对不可信 MCP 的处理） |
| 清单预算 | `min(窗口 × 5%, 4000 token)` | 18000 字符 | Hermes 的口径 |
| 退档 | 逐服务器退成只有名字，再不行每服务器一行 | 先缩描述、再丢名字 | Hermes 的三档，加一条**同一 toolkit 的多个连接合并成一组**（§4） |
| 搜索结果 | 名字和描述 | **带一行参数签名** | **带签名**。简单的工具搜完直接调，省一次 `tool_describe` |
| 调用 | 一次最多 10 个的批 | 一次一个 | **一次一个**。审批卡、确认表单、工具卡都是按单次调用设计的；要并行就让模型一步发多个调用（pi 本来就并行执行） |
| 参数校验 | 本地校验 | 可信工具才校验 | **一律本地校验**，复用 pi-ai 的 `validateToolArguments` |
| 被看过的 schema | 留在历史里 | 没说 | 留在历史里，**不升进工具表**（§7） |
| 常驻工具 | 内置不延迟，`defer` 名单可改 | `include` / `exclude` 选择器，核心工具恒直出 | 内置恒直出；连接器的**推荐集**直出（§5） |
| 中文 | 英文词干 | 明说只认英文 | **要认中文**：CJK 二元切词 + 一张小的中英意图表（§6） |

两家都没有、我们要补的有三条，都来自这次事故的形状：

1. **同一 toolkit 的多个连接**。4 个 Google Drive 的 50 把工具一模一样，清单和搜索结果要合并，调用时再指定连接。
2. **`@` 点名**。点了某个连接器，这一轮要让模型马上看到它的工具，但不能动工具表（§8）。
3. **和 Gateway 现有降级的关系**，免得两层套在一起（§9）。

---

## 2. 目标与非目标

**做成：**

1. 一颗 Bot 挂多少连接器，发给模型的工具表都不随之膨胀：内置工具 + 三把桥接工具 + 推荐集
2. 一把工具都不丢：被延迟的工具全部搜得到、调得通，审批、确认卡、流水、计费一样不少
3. 对提示缓存友好：一次目录同步之内，工具表和清单一个字节都不变
4. 连接器少的 Bot 行为不变（第 0 档）

**先不做：**

- **向量检索。** BM25 加意图表先上，搜不到的数据攒够了再说
- **供应商原生 `defer_loading` / tool search。** 只有部分模型支持，而且会改工具表、作废缓存（tool-search.md §6 第二行）
- **把搜到的工具升进工具表。** 理由见 §7

---

## 3. 什么时候开：四档

每次**目录同步**时算一次（catalog.pull 之后），定住，直到下次同步。不在每一轮重算。

设这颗 Bot 能用的连接器 / MCP 工具有 `n` 把（扣掉推荐集），清单按 §4 估算 `L` token，
预算 `B = min(窗口 × 5%, 4000)`：

| 档 | 条件 | 工具表里有什么 |
|---|---|---|
| **0 全量** | `n ≤ 30` | 今天的行为，全部直出，没有桥接工具 |
| **1 带描述的清单** | `L(名字 + 短描述) ≤ B` | 桥接三把；`tool_search` 描述里是按组的「名字 — 一句话」 |
| **2 只有名字** | `L(名字) ≤ B` | 桥接三把；清单只列名字，逐组退（工具多的组先退） |
| **3 只有组** | 名字也放不下 | 桥接三把；每组一行：「Google Drive（4 个连接，50 个工具）」 |

**第 0 档的线为什么是 30。** 30 把 schema 大约 8000 token，进缓存前缀、每轮按缓存价付一次，
比多一次搜索往返便宜。超过它，省下的前缀就比往返值钱了。这个数放进配置（§11），先按 30 上线。

**第 1 档是最要紧的一档。** 有清单，模型是在**认**工具；没清单，模型是在**猜**搜索词。Hermes
引的 Anthropic 数据里，检索失败吃掉了 26 个百分点的准确率，清单就是用来补这一截的。

按这个表，事故里那位员工：324 把，按 toolkit 合并后是 5 组（Drive、Sheets、Docs、Slides、Gmail）、
约 150 个不同的工具。名字加一句话约 4200 token，超了；只列名字约 1300 token → **第 2 档**。

---

## 4. 清单和工具 id

### id

被延迟的工具不进供应商的工具表，所以**不受 64 字符、只许 `[a-zA-Z0-9_-]` 那些限制**，不需要
`mcpToolName` 那种截断加哈希（线上的 `mcp_g_personaliuenxi_copy_file_cd04` 就是这么来的）。

id 用 `<连接>:<工具 slug>`，例如 `google_dr_syrius:GOOGLEDRIVE_FIND_FILE`。连接名是界面上那个、
人认得出来的名字。

内部照旧用 `ctx.tools` 里注册的那个长名字执行。id 和注册名之间是一张表，目录同步时建。

### 按 toolkit 合并

同一 toolkit 的几个连接，工具集合一样（员工各自关掉的那几个除外），清单里写成一组：

```
Google Drive — 连接：google_dr_syrius、g_personaliuenxi、goog_syriusdiana、google__personal
  FIND_FILE — Search files by name or query
  CREATE_FILE — Create a file in a folder
  …
Gmail — 连接：gmail_work、gmail_personal
  SEND_EMAIL — Send an email
  …
```

工具名去掉 toolkit 前缀显示（`GOOGLEDRIVE_FIND_FILE` → `FIND_FILE`），省一半字数。某个连接上
关掉了的工具，在组里标出「仅 xxx 连接」。

### 估算

`L` 用 `ceil(字符数 / 3)` 粗估，同 tool-search.md §4。只要量级。

### 排序

组按 toolkit 名排、组内按 slug 排。**不按使用频率排**：频率一变清单就变，缓存跟着废。

---

## 5. 常驻：哪些工具永远直出

- **全部内置工具**（文件、终端、浏览器、记忆、知识库、派活、转人工……）。它们是这颗 Bot 的本职，
  而且我们自己写的描述可信
- **连接器的推荐集**：上架记录里的 `recommendedTools`（tool-search.md §2 已有这个字段）。Gmail 的
  `SEND_EMAIL`、`FETCH_EMAILS` 这种天天用的，搜一次的往返不值。同一 toolkit 有多个连接时，推荐集
  每个连接各一份，所以推荐集要短（建议每个 toolkit 不超过 5 把）
- 第 0 档时全部直出

推荐集也算进 `n` 之外的那部分。合起来直出的连接器工具超过 30 把时，推荐集也按连接数从多到少退回延迟。

---

## 6. 搜索

### `tool_search({ queries: string[], limit?: number })`

- 一次可以搜几条（最多 8 条），每条结果分开给。默认每条 5 个，最多 20 个
- 打分：BM25，字段是 slug、toolkit 名、连接名、描述、参数名。slug 权重最高
- 规矩照 Hermes：结果必须含查询里最稀有的那个词；四个词以上的查询，至少命中一半。精确的 id 或
  slug 一律命中
- **中文**：Composio 的描述都是英文，模型却常用中文搜。两条一起上：
  1. 描述里的中文按 CJK 二元切词进索引（公司自己挂的 MCP 常有中文描述）
  2. 一张小的意图表，把常见中文动作和对象扩成英文再搜：发邮件 → send email、表格 → sheet
     spreadsheet、幻灯片 → slides presentation、文件夹 → folder、共享 → share permission、
     上传 → upload、日程 → calendar event……放在代码里，四五十条，不做成可配
  3. `tool_search` 的描述里明说「用英文关键词搜效果最好」
- 搜不到时回一句已连接的来源和各自的工具数，让模型换词或者用 `tool_describe` 按名字看

### 返回什么

每个结果一行，**带参数签名**（OpenClaw 的做法）：

```
google_dr_syrius:GOOGLEDRIVE_FIND_FILE(q*: string, folder_id?: string, page_size?: integer)
  Search files by name or query.   也在：g_personaliuenxi、goog_syriusdiana、google__personal
```

`*` 是必填。签名只列顶层参数和类型，嵌套对象写 `object`。参数简单的工具，模型看签名就能直接
`tool_call`，省掉 `tool_describe`。

### `tool_describe({ ids: string[] })`

回完整的 input schema（文件参数照 `annotateFileParams` 加过「先上传」的说明）。一次最多 5 个。

---

## 7. 调用

### `tool_call({ id: string, arguments: object })`

1. 按 id 找到注册名。找不到就说清楚：是 id 写错了（给三个最像的），还是这把连接现在没连上
2. **本地校验参数**：用 pi-ai 的 `validateToolArguments` 按真实 schema 校验并做类型矫正。不过就原样
   把校验错误回给模型，不打上游
3. 走 `ctx.tools.execute`，**用真名**。policy 的 pre-execute、审批、确认表单、`tool/call` 事件、
   界面上的工具卡、流水、计费全部按真名走。`policy/forms.ts` 的 `unwrapCall` 已经会剥 `SW_RUN` 的壳，
   照样加一条剥 `tool_call` 的
4. 结果原样交回，包括图片和取回的文件（connector.ts 的 landDownloads）

### 为什么不批量

Hermes 一次允许 10 个。我们的审批是按单次调用弹卡的，一批里有一个要审批，整批就得等人；
确认表单也只认一把工具的参数。模型要并行就一步里发多个 `tool_call`，pi 会并行执行，审批各管各的。

### 为什么不把用过的工具升进工具表

升进去之后模型能直接调、能用供应商侧的参数校验，看着更顺。但工具表排在提示词最前面，**它一变，
后面的缓存全废**（tool-search.md §6）。一个会话用到 k 把新工具就废 k 次，每次是整个上下文重新
按全价算。两家也都没这么做。`tool_describe` 的结果留在历史里，下一轮还看得见，够用了。

---

## 8. `@` 点名

今天点名一个连接器，它的工具这一轮进表（`toolNamesFor` 的 `mentioned`，`mentionOnly` 的服务器
只在点名时进）。延迟之后**不再动工具表**，改成在这一轮的用户消息里补一段：

```
[本轮指定连接器：Google Drive（google_dr_syrius）。可直接 tool_call 的工具：
  google_dr_syrius:GOOGLEDRIVE_FIND_FILE(q*: string, …)
  …]
```

和现在 `[本轮指定：…]` 那行是同一个位置、同一个渲染函数。工具多于 20 把时只列推荐集加一句
「其余用 tool_search」。

`mentionOnly` 的服务器：不进清单、搜不到，只有点名时才出现在这一段里。和今天一样。

---

## 9. 和 Gateway 那套的关系

Gateway 的 `tools/list` 在单连接超过 64 把时下发 `SW_SEARCH` / `SW_DESCRIBE` / `SW_RUN`。Bot 侧
开了工具搜索之后，再收到 `SW_*` 就是两层套娃：模型得先 `tool_search` 搜到 `SW_SEARCH`，再搜一遍。

所以：

- Bot 在 `tools/list` 的请求参数里声明 `{ "client": { "toolSearch": 1 } }`
- Gateway 看到这个声明就**照全量回**，不降级、不截断（截断那条 `MAX_TOOLS` 也跳过）
- 老席位不带这个声明，Gateway 行为不变

清单缓存（`toolsOf` 那五分钟）两边共用，不用改。

---

## 10. 子任务

`delegate_task` 派出去的子任务，工具集合是父任务给的那几把（`taskTools`）。子任务里的
`tool_search` 只搜得到这几把里被延迟的那部分，搜不到父任务没给的。同 Hermes 的说法。

---

## 11. 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `SATUWORK_TOOL_SEARCH` | `auto` | `auto` 按 §3 分档；`on` 跳过第 0 档；`off` 一律全量（等于今天） |
| `SATUWORK_TOOL_SEARCH_DIRECT_MAX` | `30` | 第 0 档的线 |
| `SATUWORK_TOOL_SEARCH_LISTING_MAX` | `4000` | 清单 token 上限，再和「窗口 × 5%」取小 |

先做成环境变量，跑稳了再挪进 Bot 模版。

---

## 12. 看得见

- 目录同步之后一行日志：`工具搜索：第 2 档，延迟 324 把（9 个连接、5 组），直出 40 把，清单约 1300 token`
- `request/header` 的 `sections` 加三个数：`deferredTools`、`directMcpTools`、`toolSearchTier`。
  这次排查就是靠那一行 `toolCount: 364` 才看出来的
- `/runtime/diag` 里带上当前档位和各组工具数
- 每次 `tool_search` 记一条：查询、命中数。**零命中的查询要能捞出来**，意图表靠它补

---

## 13. 不变量

1. 一次目录同步之内，发给模型的工具表和清单逐字节不变
2. 被延迟的工具一律搜得到、调得通。降级不是截断
3. 一次 `tool_call` 和直接调那把工具，在 policy、审批、事件、流水、计费上完全等价，名字也一样
4. 连接器和 MCP 的描述不进系统提示词
5. Bot 侧开了工具搜索，Gateway 就不再降级

---

## 14. 测试

- 单元：BM25 打分、中文查询（「帮我发邮件」能搜到 `SEND_EMAIL`）、按 toolkit 合并、四档的边界、id 解析
- e2e：一个挂 300 把工具的 stub MCP，验证工具表里只有内置加三把桥接；搜索、看 schema、调用一条龙；
  一把要审批的工具经 `tool_call` 调用时弹的是真名的审批卡
- 线上验证：事故那位员工的配置（4 个 Drive + Sheets + Docs + Slides + 2 个 Gmail），问一句
  「去 Drive 里找 7-11 方案」，看它几步找到、用了哪个连接

---

## 15. 取舍与风险

- **第一次用一把冷工具多一到两次往返。** 签名直出和推荐集是用来压这一条的
- **命中率看模型会不会搜。** 小模型尤其差。第 1 档的清单和意图表是主要的补救；零命中的查询要进日志
- **本地校验不如供应商校验严。** `validateToolArguments` 按 JSON Schema 校，供应商那边的私有约束
  （比如某个字段的长度）校不到，照样会被上游拒，错误原样回给模型
- **连接一增一减，缓存废一次。** 和今天一样，不更差
- **推荐集靠 owner 填。** 没填的 toolkit 就全延迟，靠清单和搜索兜底
