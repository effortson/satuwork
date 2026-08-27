# Satuwork：Skill 工具集（skills_list / skill_view / skill_manage）

Skill 现在是**系统提示词的一段**：挂上的每一条，正文全量拼进前缀，每一轮都在那儿。
本文把它改成**先看目录、要用才展开**：常驻的只剩「名字 + 一句话」，正文由模型自己
调 `skill_view` 取；ZIP 包里的参考资料、模版、脚本第一次真正到得了席位；模型攒出来的
方法可以由 `skill_manage` 写回去，成为下一次的 Skill。

形状照 [hermes 那三把](https://hermes-agent.nousresearch.com/docs/zh-Hans/reference/tools-reference)
来（`skills_list` / `skill_view` / `skill_manage`），但**落点不一样**：hermes 的 skill 是
一台机器上的 `~/.hermes/skills/`，我们的 Skill 长在 Gateway 的公司目录里、由管理员管、
往下发到每一个席位。这个差别决定了本文一半的内容（§7、§8）。

相关：装配路径见 [context-assembly.md](./context-assembly.md) §2（Skill 是那五段里的最后
一段）；「装不下就先搜后调」这套思路的另一半在 [tool-search.md](./tool-search.md)，那份
管连接器的工具，这份管 Skill。与 context-assembly.md 冲突处，以本文为准——它描述的是改
之前的 composeSystem。

---

## 1. 今天是什么样

三件事，按严重程度排：

**一、正文全量进前缀。** `composeSystem`
（[agent/index.ts:1690](../bot/src/agent/index.ts:1690)）把这颗 Bot 挂上的、启用着的
Skill 全部拼成 `## Skill: 名字` + body，接在系统提示词后面。挂三条一千字的，就是每一轮
都带着三千字——不管这一轮问的是「今天几号」还是「把上周的工单导出来」。

**二、ZIP 包里的文件根本到不了席位。** 上架时 `filesOf` 收下整包（最多 200 个文件、
5 MB，[lib/catalog.ts:616](../gateway/src/lib/catalog.ts:616)），但 `publicSkill`
（[lib/catalog.ts:658](../gateway/src/lib/catalog.ts:658)）只往外发 `fileCount` 和
`bytes`，**正文只取包里那个 `skill.md`**（[routes/catalog.ts:67](../gateway/src/routes/catalog.ts:67)）。
`/runtime/catalog` 发的就是 `publicSkill` 的结果（[routes/runtime.ts:216](../gateway/src/routes/runtime.ts:216)），
席位侧 `syncSkills`（[bot/src/catalog/index.ts:415](../bot/src/catalog/index.ts:415)）
的 `RemoteSkill` 里压根没有 `files` 这个字段。

也就是说：**管理员传了一个 ZIP，界面上写着「12 个文件」，席位上只有一个 markdown。**
模型看得见「见 `references/退款口径.md`」这句话，找不到那个文件——然后它会去猜，或者
告诉用户没有这份资料。

**三、模型学到的东西留不下来。** 一次任务里试出来的正确做法，只能落在会话里，下一次
压缩就没了。Skill 是唯一的程序性记忆，而它今天是只读的。

---

## 2. 目标与非目标

**做成：**

1. 常驻的只有**索引**（名字 + 一句话），正文按需加载
2. **按需不是删除**：索引里出现的每一条，`skill_view` 都取得到全文；ZIP 包里的每个
   文件也取得到
3. 存量行为不变：改之前挂着的 Skill，改之后仍然全文常驻（§4 的迁移口径）
4. 模型能写 Skill，但**只能写自己那一档**，进不了公司目录（§7）
5. 对提示缓存**净赚**（§10）
6. 边界不动：guard、审批、审计、计费口径全部沿用现有那套（§9）

**先不做：**

- **跨席位共享模型自建的 Skill。** 私有档就是这颗 Bot 自己的。要给全公司用，走「晋升」
  ——管理员在界面上点一下，它才变成公司目录里的一条（§7）
- **语义检索。** `skills_list` 是在几十条上做分词匹配，不是向量。几十条不值得
- **Skill 之间互相引用 / 组合。** hermes 那边也没有。先让一条 Skill 能被完整读出来
- **Skill 包文件的预览。** 界面上点不开它们（见 §6）。要能点开得给预览另开一条认「包内
  路径」的路，跟本文这套是两件事
- **脚本自动执行。** `skill_view` 把脚本**读出来**并给出路径，跑不跑、怎么跑是模型用
  `terminal` 决定的事。让 skill 工具自己 spawn，等于在 `terminal` 之外开第二条执行路径，
  而 policy 那套（审批、PII、外发闸）和后台进程注册表都是挂在那把工具上的
- **模型自己改公司目录里的 Skill。** 这条是硬的，见 §15 不变量 3

---

## 3. SKILL.md 长什么样

**不新发明格式。** 今天存的就是一段 markdown（`definition.body`），三种来源
（`手动编写` / `单文件 Skill` / `ZIP 包`，[lib/catalog.ts:556](../gateway/src/lib/catalog.ts:556)）
都落到这一个字段上。本文只加一件事：**正文开头可以有 YAML frontmatter**。

```markdown
---
name: 退款审核
description: 客户要求退款时，按金额分档走哪条流程、需要谁签字
mode: 按需
---

## 什么时候用

…
```

三个键，都可省：

| 键 | 省掉时 | 谁说了算 |
|---|---|---|
| `name` | 用目录项的 `name` | **目录项赢。** 界面上改的名字必须是最终的那个 |
| `description` | 用 `summaryOf(body)`——正文第一段没被列表符号占住的话 | frontmatter 赢 |
| `mode` | 见 §4 | 界面上的开关赢；**模型写的那一档一律 `按需`**（§7） |

`summaryOf` 已经在了（[lib/catalog.ts:591](../gateway/src/lib/catalog.ts:591)），今天用来
在列表里显示摘要。它现在多了一个职责：**没写 description 时，它就是模型决定「要不要
点开这条」的唯一依据。** 所以界面上要提示补一句（§13）。

frontmatter 在 Gateway 侧解析，解析结果进 `publicSkill`，**不改 `body` 的存法**——正文
连 frontmatter 一起存、一起显示。存两份（去掉 frontmatter 的正文 + 元数据）意味着管理员
在编辑框里改一个字，两份就开始分叉。

---

## 4. 常驻还是按需

**不是所有 Skill 都该按需。** 「回复一律用中文」「涉及金额一律复核」这种是**口径**，
它得在每一轮都成立，模型不会想到「我该去查一下有没有关于语气的 skill」。而「导出上周
工单」是**流程**，用到才需要。

所以每条 Skill 多一个字段 `mode`：

| mode | 在提示词里 | 什么时候选它 |
|---|---|---|
| `常驻` | 全文，就是今天的样子 | 口径、语气、边界、每一轮都成立的规矩。**要短** |
| `按需` | 只有一行「名字 — description」 | 流程、清单、模版、带文件的包 |

**迁移口径：存量一律写 `常驻`。** 改之前挂着的每一条，改之后行为一个字不变。新建的
默认 `按需`。

这一条不许省成「按体量自动分」（短的常驻、长的按需）——那意味着管理员某天把正文写长了
一点，Bot 的行为就静悄悄地变了，而界面上什么都没提示。这正是
[tool-search.md](./tool-search.md) §2 里反复在防的那类事。

界面上给一键切换，并且在切到 `按需` 时说清楚代价：模型可能不去点开它（§17 风险 1）。

---

## 5. 索引放哪儿：进提示词，不做常驻的 list 工具

索引是**稳定**的（名字 + 一句话，改得少）、**小**的（一条一行）。稳定又小的东西属于
前缀——它在缓存里，每一轮按 cacheRead 单价付，几乎不要钱。

反过来，把索引做成一把常驻的 `skills_list` 工具，代价是**一次往返**：模型得先调一次才
知道有什么。而在提示词里，它一开口就知道。默认 provider 是 deepseek，少一次「想起来
要去列一下」的机会，命中率差得远——同 [tool-search.md](./tool-search.md) §4 第 1 档
不能省的那条理由。

于是分两档，每轮 `composeSystem` 重算，不缓存档位。设按需的 Skill 有 `n` 条、索引文本
估算 `L` token：

**`L` 用现成的 `estTokens`（[agent/index.ts:2011](../bot/src/agent/index.ts:2011)），
不要照抄 [tool-search.md](./tool-search.md) §4 的 `chars / 3`。** 那一条估的是英文工具
清单；Skill 的名字和 description 是中文，而 `estTokens` 里 CJK 是**一字一 token**、其余
才按 3.6 字符算。拿 `chars / 3` 去估一份中文索引，会把它低估到三分之一——分档线当场失效，
第 0 档能塞进去三倍于预算的东西。这个函数就在同一个文件里，不用另写一个。

| 档 | 条件 | 提示词里放什么 | 工具表里给哪几把 |
|---|---|---|---|
| **空** | 一条 Skill 都没有 | 什么都不加 | 只有 `skill_manage` |
| **0** | `L ≤ SATUWORK_SKILL_INDEX_MAX_TOKENS` | 完整索引，一条一行 | `skill_view` + `skill_manage` |
| **1** | 超了 | 一行摘要：「这台席位有 N 条 Skill，用 `skills_list` 找」 | 再加 `skills_list` |

**`skills_list` 只在第 1 档给。** 索引已经在提示词里的时候还摆一把「列出 Skill」的
工具，是在邀请模型多打一轮它不需要的往返。

**一条 Skill 都没有时连 `skill_view` 也不给。** 那时它唯一可能的结果是「这台席位上一条
Skill 都没有」——摆一把只会失败的工具，是在教模型走一条走不到的路，和三段硬编码提示词
的条件加载是同一条口径（[context-assembly.md](./context-assembly.md) §2）。`skill_manage`
这一档照给：不然这台席位永远迈不出第一步，而记下第一条之后 `skill_view` 下一轮自己就
回来了（判据在 `skillTools`，纯函数，和 `skillSplit` 一样由探针直接打）。

三档都只是**遮掩**，不是强制：模型硬报一个不在表里的名字照样调得到，真正的判定在
Gateway 那侧的写接口和 policy 上。

索引一条一行，名字在前——模型要拿它去 `skill_view`：

```
- 退款审核：客户要求退款时，按金额分档走哪条流程、需要谁签字
- 周报模版：把一周的工单和会话汇成那份固定格式的周报（带 3 个文件）
```

### 拿什么去指一条 Skill：名字，不是 id

目录项的 id 是一串随机字符，模型抄错一个字符就是一次失败调用，而它看不出错在哪。
**所以 `skill_view` 收的是名字**——索引里印着的那个，它照抄就行。

**不做拼音 / 英文 slug。** 公司的 Skill 名字绝大多数是中文（「退款审核」「周报模版」），
按「小写、非字母数字换 `-`」那套归一化，剩下的是一根空横线；硬给它造一个拼音 slug，等于
在「模型看见的名字」和「它要传的参数」之间人为插一层不一致，而那一层每错一次都是一轮
白跑。JSON 参数里放中文没有任何问题。

只有**重名**才需要区分：同名的按「本公司 > 全局」定序，后来的那条在索引里显示成
`退款审核（2）`，`skill_view` 也认这个写法。这份归一化由 Gateway 算、随 `publicSkill`
一起下发——两边各算一次，迟早在某个 Unicode 边界上分叉。

`skill_view` 三种都认：名字、带序号的名字、id。**都对不上时不许回错就完**，要带一句
可执行的建议（§15 不变量 5）。

---

## 6. 三把工具的契约

**三个名字照上游原样抄**，包括 `skills_list` 那个和另外两把不一致的复数。理由和
[file-terminal-tools.md](./file-terminal-tools.md) §1 换 file / terminal 时是同一条：工具名
越接近模型见过的约定，调用就越准，这个收益压得过「前缀整齐」那点洁癖。真要统一成
`skill_list`，收益是我们自己看着舒服，代价是模型第一次调的时候要猜。

### `skill_view(skill, file?)`

`risk: ['read']`。

- 不带 `file`：返回这条 Skill 的完整正文，外加**它带了哪些文件**（路径 + 字节数，
  一行一个）。这是第一次调用该看到的东西
- 带 `file`：返回包里那个文件的内容。路径按包内相对路径给，`..` 越界直接拒
- 正文和文件都过 `SATUWORK_SKILL_VIEW_MAX_CHARS`（默认 40 000 字符）截断，尾巴上写明截了多少
  ——喂回模型的东西必须有界，理由同 [tools/file.ts:35](../bot/src/tools/file.ts:35) 那一排上限
- 二进制文件不回内容，回「这是二进制，路径在 X，用 `terminal` 处理」

**`files` 和 `refs` 两个字段都不填。** 它们的契约是**工作区文件**——路径相对工作区根，
界面按这个路径去开预览（`knownFiles`，[chat.js:2387](../gateway/ui/chat.js:2387)）。Skill
的包文件在席位私有目录里，不在工作区，填进去就是一排点不开的链接，比不给还糟。

文件清单只写在 `text` 里（路径 + 字节数）。要让它们在界面上能点开，得给预览另开一条
认「skill 包内路径」的路，那是另一件事，本文不做。

### `skills_list(query?, limit?)`

`risk: ['read']`。只在第 1 档注册（§5）。

- 在**本机已同步的**索引上做大小写不敏感的分词匹配：名字 + description + 标签，命中
  名字权重最高。不打 Gateway
- `limit` 默认 `SATUWORK_SKILL_SEARCH_LIMIT`（10），硬上限 20
- 返回每条名字 + description，**不返回正文**——正文去 `skill_view`
- **搜不到不许回空**。回一句人话，并把现有标签列出来当路标：

  > 「这台席位有 24 条 Skill，"发工资" 没有命中任何一条。现有的标签是：客服、数据分析、
  > 销售、行政支持。换个词试试，或者用 `skills_list()` 不带参数看全部。」

  静默的空结果在模型眼里等于「这个东西不存在」，它会转头告诉用户做不到。这是静默截断
  换了个马甲。

### `skill_manage(action, ...)`

`risk: ['write']`。**不标 `external`**——见 §9，那一位会让「关掉外发」的 Bot 连自己的
记忆都写不了。

| action | 参数 | 干什么 |
|---|---|---|
| `create` | `name`, `body`, `tags?`, `mode?` | 新建一条**私有** Skill |
| `update` | `skill`, `body?`, `name?`, `tags?`, `mode?` | 改自己那条 |
| `remove` | `skill` | 删自己那条 |

三条都只作用在**私有档**（§7）。`skill` 参数指到公司目录或全局目录的条目时，回一句
明确的拒绝，**不是一个模糊的失败**：

> 「退款审核 是公司目录里的 Skill，我改不了。要改得请管理员在 Skill 页面上改。
> 我可以另建一条自己的补充说明。」

写成功之后返回**它最终叫什么、以及当前私有档条数**（`7/30`）——模型得知道自己快写满了。

---

## 7. 模型写出来的 Skill 落在哪儿

这是本文最需要拿主意的一处。三个候选：

| 落点 | 活多久 | 谁看得见 | 问题 |
|---|---|---|---|
| 席位私有目录 `~/.satuwork/<seatId>/` | 到这个席位被回收为止（[manager/src/reclaim.ts:95](../manager/src/reclaim.ts:95)） | 没人 | 换版重启活着，回收就没了；管理员看不见 Bot 给自己写了什么 |
| 共享工作区 `/home/<user>/work` | 长 | 员工自己 | 模型的 `terminal` 能 `rm -rf` 它；它是资料区，不是记忆区 |
| **Gateway，私有档** | **和公司数据一样长** | **员工 + 管理员** | 要加写接口 |

**选第三个。** 理由按份量排：

1. **看得见才管得住。** Bot 给自己写下的方法会持续改变它的行为。这种东西攒在一台机器
   的某个目录里、管理员从界面上翻不到，是在给自己造一个查不了的故障源
2. **席位是可回收的。** `reclaim` 会把整个席位目录删掉，换机器、换槽位都会。把唯一
   一份记忆放在最短命的那一层上，等于说「它随时可以没有」
3. **一颗 Bot 可能有多个席位。** 同一员工的席位共用工作区，但 `$SATUWORK_HOME` 是各自
   一份。落在席位上，两个席位学到的东西对不上

所以：

- **不新增 scope。** `catalog_items` 上已经有 `scope = 'user'` 和 `accountId` 这一维，
  员工自建的 Bot 就长在上面（`botsFor`，[db.ts:2538](../gateway/src/db.ts:2538)）。私有
  Skill 用同一套，缺的只是「哪颗 Bot」——加一列 `botId`，迁移 `0017-seat-skills.ts`
- **可见性写进 where，不在调用点过滤。** `botsFor` 的注释已经把这条立成规矩了：「这条线
  由这里的 where 保证，而不是靠每个调用点自己过滤」。私有 Skill 照办——新增
  `skillsFor(companyId, accountId, botId)`，`/runtime/catalog` 改用它。在应用层 filter
  一次就够漏一次，而漏的表现是「别人的 Bot 学到的东西出现在我这儿」
- 席位通过 `POST /runtime/skills` 写，认的是现有那把 runtime token（和 `/runtime/catalog`
  同一把），Gateway 从 token 上取账号，**从 `SATUWORK_BOT_ID` 取 botId，不认请求体里的**
- 写进去之后照常走 `/runtime/catalog` 下发回来——**写路径和读路径不共用一份数据**是
  这类设计最容易出的分叉，这里不留那个口子：写完让它自己 pull 一次
- 落 `catalog.create` / `catalog.update` / `catalog.delete` 审计（`auditCatalog` 已经在），
  **actor 记成这颗 Bot**，不是员工本人。审计页上要分得出「人改的」和「Bot 自己改的」
- 私有档**不进别的 Bot 的目录**：`visibleCatalog` 是「全局 ∪ 本公司」，seat 档要额外
  按 botId 过滤

### 会话中途记下来：一次走查

这是 `skill_manage` 存在的主要场景——**跑完一件事，把方法留下来**，而不是等管理员事后
去界面上补一条。走一遍完整时序，因为中间有一处很容易做错。

> 用户：「以后每周的工单导出都按刚才那样干。」

1. 模型调 `skill_manage(action: 'create', name: '周报工单导出', body: '…')`
2. 席位 `POST /runtime/skills`。Gateway 归一化（frontmatter、重名去重、`mode` 一律 `按需`）、
   查上限、跑 PII 扫描、落审计，**把归一化之后的整条记录回给席位**
3. 席位把这条记录原样写进 `CachedSkill` 缓存，并**顺手触发一次目录 pull**
4. 工具返回给模型：它最终叫什么、当前条数（`7/30`），外加一句
   **「已保存。它从下一轮开始出现在你的 Skill 索引里。」**
5. 模型对用户说一句「我记下来了：周报工单导出」。界面上同时出一张卡片（§13）

**第 4 步那句话不是客套。** 这一轮的系统提示词和工具表在 `runTurn` 开头就定死了
（[context-assembly.md](./context-assembly.md) §1），新建的 Skill **这一轮不进索引**。
不说这句，模型会当场 `skills_list` 一次、发现找不到，然后转头告诉用户「好像没保存上」
——一次成功的写入被它自己描述成了失败。同理，返回里要带**归一化之后的正文快照**，
让它这一轮就用得上，不必再 `skill_view` 一趟。

**第 2、3 步之间是最容易做错的一处。** 席位不许自己拼一条记录塞进缓存——重名怎么去重、
`mode` 落成什么、正文被截了没有，全是 Gateway 说了算，本地拼一份就等于两边各有一套
归一化逻辑，而它们一定会分叉。落进缓存的那份**必须是 Gateway 回来的那份**。

还有一处不做就会「写成功了但永远看不见」：**`catalogStamp` 必须把私有档算进去**
（[routes/runtime.ts:201](../gateway/src/routes/runtime.ts:201)）。指纹不含它的话，每分钟
那次探针判定「没变」，索引里就永远不会出现这条——而工具明明回了成功。

### 模型只能写「按需」

`mode` 这个参数**模型给不了**，`skill_manage` 一律落 `按需`。

`常驻` 是「每一轮都成立的口径」，它直接改这颗 Bot 之后每一句话的行为，还占着前缀。
这是管理员的权限，不是模型能给自己开的。模型觉得某条该常驻，就在正文里说，让人去点。

### 同名不许静默新建第二条

名字撞了的时候，`create` **不许**自动变成「周报工单导出（2）」。回一句带现有正文的拒绝：

> 「已经有一条『周报工单导出』了（正文见下）。要改它就用 `update`，确实是另一件事就
> 换个名字。」

自动加序号的结果是攒出「周报流程」「周报流程（2）」「周报流程（3）」，三条都半对，而索引在
前缀里、三条都要每轮付一次钱。**人手建的那条撞名照旧允许**（那是管理员知道自己在干
什么），这条只管模型。

### 定时任务里也一样

[routines.md](./routines.md) 那条路跑出来的会话同样握着 `skill_manage`——它就是一次
普通的会话轮次。要说清的是：那种会话**没有人在旁边看**，所以第 5 步那张卡片是异步被
看到的，界面上私有档那一栏的角标是唯一的提示。上限（30 条）在这个场景下更要紧。

**晋升要人点。** 界面上给私有 Skill 一个「转成公司 Skill」的按钮，管理员点了才进公司
目录。没有自动晋升，也没有「攒够几次就自动提升」——公司目录是所有人共用的东西，往里
写只能是人的决定。

### 上限

模型写 Skill 的失败模式是**写太多**：索引在前缀里，每多一条就每一轮多付一次。

| 上限 | 默认 | 超了怎么办 |
|---|---|---|
| 私有档条数 | 30 | `create` 拒绝，回一句「先 `remove` 掉用不上的」 |
| 单条正文 | 8 000 字符 | 拒绝，让它写短 |
| description | 200 字符 | 截断，不拒绝 |

---

## 8. 文件怎么到席位

`/runtime/catalog` **不带文件**。那条路每分钟被探针摸一次、整份下发，把 5 MB 的包塞进去
等于给每一次目录同步加一个数量级——而绝大多数轮次里没有任何 Skill 被打开。

改为**用到才拉**：

```
GET /runtime/skills/:skillId/files?botId=…            → [{ path, bytes }]
GET /runtime/skills/:skillId/file?botId=…&path=…      → 那个文件的内容
```

**路径走 query，不走路径段。** 这个 router 按段数精确匹配（[http.ts:71](../gateway/src/http.ts:71)
的 `match`），拼不出 `files/*` 那一段通配；而包里的路径带 `/`。

席位侧缓存在 `$SATUWORK_HOME/skills/<skillId>/`，**按 `updatedAt` 作键**：目录同步回来的
`updatedAt` 比缓存新就重拉。缓存被删了也无所谓——它只是缓存。

`terminal` 需要跑包里的脚本时，`skill_view` 给的是**绝对路径**（`/home/u/.satuwork/<seat>/skills/<id>/scripts/x.py`）。
工作区的根在别处，路径参数越界会被拒，但 `terminal` 拿到的是真 shell，绝对路径跑得通——
这不是绕过什么，[tools/terminal.ts:22](../bot/src/tools/terminal.ts:22) 的类注释里早写清楚
了「这不是沙箱」，真正的边界在操作系统那层。

**不往工作区里铺一份。** 铺进去就有两份，模型改了工作区那份、下次同步又被覆盖，而它
不会知道。工作区是员工的资料区，不是我们的运行时目录。

拉不到时（Gateway 抖了、Skill 刚被删）**要说明是哪一种**：

> 「这条 Skill 的文件清单取不到（Gateway 暂时连不上），正文我手上有。」

和「这条 Skill 没有文件」混成同一个空列表的话，供应商抖一下模型就会告诉用户资料不存在
——同 [tool-search.md](./tool-search.md) §10 不变量 7。

---

## 9. 边界这一层

**两个标注，一个都不能少**（[tools/index.ts](../bot/src/tools/index.ts) 的 `ToolRisk` 与
`ToolDelegation`）。`register` 会拦：**内置工具没写 `delegation` 就抛，进程直接起不来**
（[tools/index.ts:235](../bot/src/tools/index.ts:235)）——所以这一列不是「建议」，是不写
就起不来那一类的东西：

| 工具 | risk | delegation | 后果 |
|---|---|---|---|
| `skill_view` | `['read']` | `{}` | 什么都不拦，子代理照常有 |
| `skills_list` | `['read']` | `{}` | 什么都不拦，子代理照常有 |
| `skill_manage` | `['write']` | `{ mode: 'root-only' }` | 不触发审批（那条要 `external + write`），不被外发闸拦；子代理没有它（见下） |

三把都不标 `rebind`、不标 `retains`：它们不按 sessionId 记账，也不留下还活着的东西。
`skill_manage` 写出去的东西活得比会话长，但那份在 Gateway 上，不是席位上的一个句柄。

**为什么 `skill_manage` 不标 `external`。** `external` 的定义是「出这台席位，打别人家的
系统」。Gateway 是我们自己的控制面，不是别人家；而 `no-external` 这道闸打开时
（[policy/index.ts:655](../bot/src/policy/index.ts:655)）会把带这一位的工具全挡掉——
标了它，等于「关掉外发」的 Bot 连自己的记忆都写不进去。而外发闸想防的是「把公司数据
发出去」，写一条自己的 Skill 不是那件事。

**PII 那一道同样不适用**：`outboundOf`（[policy/index.ts:776](../bot/src/policy/index.ts:776)）
认的是 `external`。要说清楚这意味着什么——**模型可以把它这一轮看到的东西写进 Skill 正文
里，包括不该长期留着的**。这是真实存在的口子，两条拦法：

1. `skill_manage` 的 description 里明写「Skill 是长期留下的方法，不要把具体的人名、
   单号、密钥写进去」
2. 写入前在**席位侧**扫一遍：`scanPii`（[policy/pii.ts:60](../bot/src/policy/pii.ts:60)）
   已经在那儿了，`skill_manage` 直接调它，命中的类型随写入一起发上去，Gateway **只存
   不判**，界面上标红让管理员看见。

   **不在 Gateway 上再实现一份。** 判据抄第二份就一定会分叉，而分叉的表现是「席位说
   干净、界面说有身份证号」——这条规矩 [tool-search.md](./tool-search.md) §10 不变量 3
   已经立过一次了

不做成「命中就拒绝」：那会让模型反复重试同一件事，而它不知道哪个字触发了。

### 委派：`skill_manage` 是 root-only

[delegation.md](./delegation.md) 那套（`delegationOf`，主代理表减三档）把这件事变成一行
标注：

| 工具 | 委派标注 | 为什么 |
|---|---|---|
| `skill_view` / `skills_list` | 照常给子代理 | Skill 是「这家公司怎么做这件事」，子代理不看就会用通用做法把活干完——结论看着对、口径全错。`taskSystem`（[agent/index.ts:654](../bot/src/agent/index.ts:654)）本来就把 Skill 段整段继承下去 |
| `skill_manage` | **`mode: 'root-only'`** | 写记忆是主会话的事。子代理跑完就没了、也没有人在看它，而一次委派开出五个子代理，每个都觉得自己学到了点什么，就是五条私有档 |

子代理要留下方法，就把它写进交回来的结论里，由主代理决定记不记——**决定权跟着那条
和人对着的会话走**。

**审计**：三个 action 全部落审计，见 §7。

**计费**：三把工具都**不计费**、不落 `connector_calls`——它们不产生供应商侧执行，同
[tool-search.md](./tool-search.md) §7 里 `SW_SEARCH` / `SW_DESCRIBE` 那一档。成本落在
model token 那条线上（多的那一两轮往返），账本里看得见。

---

## 10. 缓存这笔账

结论先放：**这套做法对提示缓存是净赚的。**

断点位置见 [tool-search.md](./tool-search.md) §6：一个打在最后一个工具上（前缀 = 系统
提示词 + 整个 tools 块），一个滚动打在最后一条 user / tool_result 上。

| | 今天 | 改完 |
|---|---|---|
| 前缀里的 Skill | 全部启用条目的正文全文 | `常驻` 的正文 + 按需条目的索引行 |
| 打开一条 Skill | 不用打开，一直在 | 一次 `skill_view`，结果进 messages，**下一轮就被滚动断点收进缓存** |
| 管理员改了一条 Skill | 前缀作废 | `常驻` 的改了才作废；`按需` 的只在索引行（名字 / description）变了才作废 |

第三行是容易被忽略的一笔：今天**任何一条 Skill 正文改一个字，整条会话的前缀全部作废**，
而目录探针每分钟跑一次。改完之后，改正文不动前缀。

多花的是 `skill_view` 那一次全价 input（一条 skill 几百到几千 token，下一轮进缓存）。
只要一条会话里没有把所有 Skill 都打开一遍，就是赚的。

这笔账落在 [lib/pricing.ts](../gateway/src/lib/pricing.ts) 已经分开的
`input / cacheRead / cacheWrite` 三档上，上线后从账本里直接读得出来，不用估。

---

## 11. 压缩、重放与占比

**压缩会把 `skill_view` 的结果压掉。** 一条长任务跑到一半触发压缩，模型手上那份流程
就没了，而它**不知道自己曾经打开过**——它会照着摘要继续干，干得看起来很像那么回事。

两条：

1. 摘要提示词（`SUMMARY_SYSTEM`，[agent/index.ts:1593](../bot/src/agent/index.ts:1593)）
   里加一句：**保留这一段里打开过哪些 Skill（写名字）**。摘要里有名字，模型重新
   `skill_view` 一次就回来了
2. `skill_view` 的返回开头带一行 `Skill: <名字>`——摘要模型照抄一行比从散文里认出来准

**重放**：`skill_view` 是纯读，重放一条历史会话时不需要重新执行；它的结果本来就在事件
日志里。**但它读到的东西可能已经变了**，这跟工具表可能已经变了是同一类事，不特殊处理。

**占比那颗 chip**：`sections.skills`（[agent/index.ts:1323](../bot/src/agent/index.ts:1323)）
今天报的是「Skill 正文」。改完之后它报的是「常驻正文 + 索引」，数字会明显变小——这是
**对的**，但界面上那一格的 tooltip 要跟着改口径，不然管理员会以为 Skill 没生效。
按需加载的那部分算在对话历史里，本来就该在那儿。

---

## 12. 配置

这几条全在**席位**上（分档、上限、缓存都发生在那儿），所以照席位的命名走 `SATUWORK_`
前缀——`GATEWAY_*` 是「连哪台控制面」，`CONNECTOR_*` 是 Gateway 自己的。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `SATUWORK_SKILL_INDEX_MAX_TOKENS` | 2000 | §5 第 0 档和第 1 档的分界。索引超过它才注册 `skills_list` |
| `SATUWORK_SKILL_VIEW_MAX_CHARS` | 40000 | `skill_view` 单次返回的上限，超了截断并写明截了多少 |
| `SATUWORK_SKILL_SEARCH_LIMIT` | 10 | `skills_list` 默认返回条数 |
| `SATUWORK_SKILL_SEARCH_MAX_LIMIT` | 20 | 硬上限，模型传再大也压到这个数 |
| `GATEWAY_SEAT_SKILL_MAX` | 30 | 一颗 Bot 的私有档条数上限（§7）。**在 Gateway 上**，见下 |
| `GATEWAY_SEAT_SKILL_BODY_MAX` | 8000 | 模型写的单条正文字符上限。同上 |
| `SATUWORK_SKILL_FILES_CACHE_MAX` | 64 MB | 席位上 skill 文件缓存的总量封顶，按 `updatedAt` 淘汰 |
| `SATUWORK_SKILL_TOOLS` | `auto` | `auto` 按 §5 分档；`off` 退回今天的行为（全部 `常驻`、不注册任何 skill 工具） |

那两条 `GATEWAY_*` 是**写入那一侧**的判据，所以不在席位上：两边各写一份上限，迟早一边
说存下了、另一边说满了。模型看到的那句「7/30」也是 Gateway 回过去的。

`off` 那一档要**保留**——它是这套东西出问题时的退路，退路不能在同一次改动里一起删掉。
`skill_manage` 另有一道开关，在 Bot 模版上（界面里的勾选框），不是环境变量：它是管理员
的决定，不是部署的决定。

---

## 13. 界面

1. **Skill 编辑弹窗加 `mode` 开关**（常驻 / 按需），默认按需；存量打开时显示常驻。旁边
   一句说明，把 §4 那个分界讲成人话
2. **description 缺失时提示。** 没有 frontmatter `description`、`summaryOf` 又取不到
   （正文整篇都是列表）时，在列表里标一句「模型看不懂这条是干什么的」——这是按需档里
   唯一决定它会不会被打开的东西
3. **ZIP 包的文件清单要能展开看。** 今天只显示 `fileCount`。既然文件真的下发了，管理员
   得能核对包里有什么
4. **私有档单独一栏**：「Bot 自己写的」，带来源（哪颗 Bot、哪次会话）、时间、「转成公司
   Skill」和「删掉」两个按钮。**默认折叠，但有条数角标**
5. **会话里当场出一张卡片。** `skill_manage` 写成功时，对话流里落一条「记下了一条方法：
   周报工单导出 ｜ 看看 ｜ 删掉」。这是员工唯一一次**在事情发生的当下**看见 Bot 改了
   自己的机会——事后去 Skill 页面翻，等于没有。「删掉」走的是同一条私有档删除接口。

   走法照 `todo` 那条现成的路：工具里 `ctx.sessions.append(sessionId, 'skill/saved', …)`
   （[todo.ts:300](../bot/src/tools/todo.ts:300)），事件类型在
   [session/types.ts:359](../bot/src/session/types.ts:359) 一带声明，`chat.js` 加一个分支
   （[chat.js:713](../gateway/ui/chat.js:713) 那个 `todo/list` 挨着）。**不许让界面去扫
   工具结果的文本**——那段文本是写给模型的散文，措辞一改就扫不出来，这条道理在
   `ToolResult.files` 的注释里已经写死了
6. `GET /orgs/:id/skills/:skillId` 的响应里加 `mode`、`hasFiles`、`displayName`（重名
   序号）和包内文件清单，**界面不许自己按正文长度去推常驻还是按需**——推的那一刻就跟
   后端分叉了

---

## 14. 改动清单

**Gateway**

- `lib/catalog.ts`：frontmatter 解析、重名去重、`mode` 字段、`publicSkill` 输出这几样
- `routes/catalog.ts`：`newSkillDefinition` / `applySkillPatch` 收下 `mode`；清单里带上
  私有档（`listSkills`）；`POST …/skills/:id/promote` 晋升；DELETE 也认私有档；单条详情
  多带一份包内文件清单
- `lib/catalog.ts`：模版上新增 `selfSkills`（「让它自己记 Skill」，**默认开**，§7）
- `routes/runtime.ts`：新增 `GET /runtime/skills/:id/files`、`GET /runtime/skills/:id/files/*`；
  新增 `POST /runtime/skills`、`PATCH`、`DELETE`（私有档，从 token + `botId` 定身份）；
  另有一条 `DELETE /runtime/bots/:botId/skills/:skillId` 给**人**用——对话里那张卡上的
  「删掉」走它，成员账号进不了 `/orgs/:id/skills/*`
- `db.ts` + `db/migrations/0017-seat-skills.ts`：`catalog_items` 加 `botId` 列；新增
  `skillsFor(companyId, accountId, botId)`，可见性判在 where 里（§7）
- 目录指纹 `catalogStamp` 要把私有档算进去，否则 Bot 自己写完不会自己看见

**Bot**

- `catalog/index.ts`：`RemoteSkill` 加 `mode` / `description` / `hasFiles`（重名序号跟着名字一起下发）；
  `CachedSkill` 跟着加
- `agent/index.ts`：`composeSystem` 分常驻与索引两段；`sections.skills` 口径跟着改；
  `SUMMARY_SYSTEM` 加一句。`taskSystem` 不用改——它继承的是 `composeSystem` 的结果
- `tools/skill.ts`（新）：第三个工具集，三把工具 + 文件缓存。形状照
  [file-terminal-tools.md](./file-terminal-tools.md) 那两把来；三把都要写 `delegation`
  标注，不写进程起不来（§9）
- `session/types.ts`：新增 `skill/saved` 事件（§13 第 5 条）
- `registry/index.ts`：`BotRecord.selfSkills`（模版上那个开关，缺字段按开算）
- 工具表：三把各有各的进表条件，判据收在 `skillTools`（纯函数，§5 那张表）；
  `skill_manage` 标 `mode: 'root-only'`（§9）

**文档**

- `context-assembly.md` §2 那张表的最后一行要改（它现在写的是「body 全文」）
- 新事件 `skill/saved` 登记在 [session/types.ts](../bot/src/session/types.ts) 上，照
  `todo/list` 那条的写法带上「为什么存在、退化成什么样」。
  **不进 `session-event-field-map.md`**——那份是 dsh 日志格式的逆向记录，不是我们的事件表
- `README.md` 加一节「技能」，指到本文——README 现在没提 Skill，而它是管理员第一眼看的地方

---

## 15. 不变量

接在 [tool-search.md](./tool-search.md) §10 那张单子后面，编号另起：

1. **按需不是删除。** 索引里出现的每一条，`skill_view` 都取得到全文和全部文件。取不到
   要说清是「拉不到」还是「没有」
2. **存量 Skill 的行为不变。** 迁移一律写 `常驻`；只有人在界面上改过，行为才变
3. **`skill_manage` 只碰私有档。** 公司目录和全局目录的条目，模型读得到、改不动。晋升
   是人的动作
4. **归一化只有一份，在 Gateway。** `skill_manage` 写 Gateway，落进席位缓存的必须是
   Gateway 回来的那条记录。席位不许自己拼一份，也不许就地改缓存里的正文。
   （PII 扫描不在此列：那份判据在席位上，Gateway 只存结果，见 §9）
5. **搜不到 / 找不到要说话。** `skills_list` 空结果、`skill_view` 名字对不上，都必须带
   一句可执行的建议，不许回空数组或裸错误
6. **索引在前缀，正文在消息里。** 反过来（正文进前缀、索引靠工具查）两头都亏：既没省
   前缀，又多一轮往返
7. **`skill_manage` 不带 `external` 位。** 带了就等于让外发闸关掉 Bot 的记忆（§9）
8. **私有档不跨 Bot。** 一颗 Bot 写的东西，另一颗看不见，除非被晋升
9. **skill 文件缓存是缓存。** 删掉、丢掉、机器换了都不算数据丢失，重拉即可。**唯一
   一份**永远在 Gateway
10. **审计分得出人和 Bot。** 私有档的每一次写都记 actor，界面上分得开
11. **模型写不了 `常驻`。** `skill_manage` 一律落 `按需`；改成常驻是管理员的动作（§7）
12. **写成功要说「下一轮才看得见」。** 这一轮的提示词已经定死，新建的 Skill 不在索引里。
    不说这一句，模型会把一次成功的写入描述成失败
13. **同名不许静默新建第二条。** `create` 撞了名字就拒绝并附上现有正文，不自动加序号
14. **`skill_manage` 不给子代理**（`root-only`）。子代理读得到 Skill，写不了（§9）
15. **一条 Skill 都没有时不摆 `skill_view`，但 `skill_manage` 要在。** 前者那时只会失败，
    后者是这台席位记下第一条的唯一入口（§5）

---

## 16. 里程碑

1. ~~**Gateway：frontmatter + 重名去重 + mode + 文件下发接口。**~~ 已落地：
   [lib/catalog.ts](../gateway/src/lib/catalog.ts)（`skillFrontmatter` / `skillDisplayNames` /
   `skillModeOf` / `skillFiles`，`publicSkill` 多发 `mode` / `description` / `hasFiles` /
   `displayName`）+ [routes/runtime.ts](../gateway/src/routes/runtime.ts)（按 Bot 取 Skill、
   包文件两条、私有档三条写）
2. ~~**Bot：`skill_view` + 两档索引。**~~ 已落地：`skillSplit`
   （[agent/index.ts](../bot/src/agent/index.ts)，纯函数，`composeSystem` 和
   `toolSchemasFor` 共用一份判断）+ [tools/skill.ts](../bot/src/tools/skill.ts)
3. ~~**界面：`mode` 开关 + 文件清单 + description 提示。**~~ 已落地：编辑弹窗多一行
   「什么时候生效」，卡片上带档位药丸，按需档没写说明会当场标出来
4. ~~**私有档：`skill_manage` + 晋升按钮 + 审计。**~~ 已落地：`scope='user'` + `botId`
   （迁移 `0017-seat-skills`），Skill 页面上「Bot 自己写的」那一栏，对话里那张
   `skill/saved` 卡，审计 detail 里 `by: 'bot'`
5. **评测。** 拿一份真实的公司 Skill 集（十几条，含两个 ZIP 包），量「用户一句话 → 模型
   打开了正确的那条」的命中率，deepseek / claude 各跑一遍。**这一步不做不算做完**，理由
   见 §17 风险 1

测试（都已落地，`node e2e/run.mjs`，先 `docker compose up -d postgres`）：

- [e2e/skills.mjs](../e2e/skills.mjs) 十三条，Gateway 侧：frontmatter 赢过正文首段、
  存量读成常驻而新建默认按需、重名带序号、包文件不随目录下发而是按需拉、私有档落
  `scope='user'`、指纹跟着私有档变、私有档不跨 Bot、撞名与写满、模型改不动公司目录、
  晋升是搬不是拷、主人删得掉别人删不掉、管理员也删得掉、审计分得出人和 Bot、模版开关下发
- [e2e/skills-bot.mjs](../e2e/skills-bot.mjs) 十条（探针 [bot/e2e-skills.mjs](../bot/e2e-skills.mjs)），
  席位侧：两档分档（**中文索引那一条正是在钉估长口径**）、risk 与 `root-only` 标注、
  找不到 / 搜不到的话术、包文件按需拉且拉过就缓存、写成功要说「下一轮才看得见」、
  那张 `skill/saved` 卡

**`bot/e2e-mounted.mjs` 的工具名单也要跟着加三个**——那份名单是「少一把工具而所有信号
都是绿的」这类事故的唯一防线。

---

## 17. 明说的取舍与风险

1. **最大的风险是模型不去打开它。** 按需加载把「Skill 占上下文」换成了「Skill 可能不
   生效」，而后者**在日志里看不出来**——模型只是没调那把工具，回答看起来正常。这比
   前一个问题更难查。三条对策：`常驻` 那一档留着（口径类的东西根本不该按需）、
   description 的质量在界面上盯着、里程碑 5 是验收条件不是可选项
2. **多一轮往返。** 用户感知是「慢了一拍」。索引在前缀里能明显减少空转，这也是 §5 那个
   决定的全部理由
3. **成本换了口袋。** 前缀省下来的，一部分变成 `skill_view` 的一次性 input。§10 那张表
   算过，会话越长越赚，单轮问答略亏
4. **私有档是一条新的写路径。** 今天目录只有人能写；这一改，一个模型也能往库里写东西。
   §7 的三道闸（只写自己那档、条数上限、全量审计）是按「它一定会写出些没用的东西」设计
   的，不是按「它会写得很好」
5. **PII 那个口子是真的。** 见 §9。标记而不是拒绝，是权衡后的选择，要在上线说明里写给
   管理员看
6. **ZIP 包的文件第一次真的落到席位磁盘上。** 5 MB × 条数是磁盘占用的上限，缓存要有
   清理（按 `updatedAt` 淘汰，或者干脆按席位总量封顶）。这一条别拖到磁盘满了才做
