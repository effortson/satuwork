# 公司管理员：自动对话审计与删除前终审

本文定义公司管理员自动对话审计的第一版实现方案。它是在现有“Gateway 只存会话索引、
会话 JSONL 留在运行机器”的架构上新增的一类**受控派生内容**，不改变原始会话的事实源。

相关现状：

- 会话索引与按需拉全文：[gateway-runtime.md](./gateway-runtime.md) 第 10、11 节
- Gateway 调度先例：[routines.md](./routines.md) 第 2、3 节
- 当前 Bot 删除链路：`gateway/src/routes/runtime.ts`、`gateway/src/deploy.ts`、
  `gateway/src/db.ts#deleteBot`

---

## 1. 结论与需要先修正的口径

整体方向合理，但必须满足四个前提：

1. **审计摘要不能塞进 `audit_events`。** `audit_events` 回答“谁改了什么”，新数据回答
   “Bot 在一段时间里处理了什么”，体量、敏感度、查询方式和留存周期都不同。
2. **删除必须改成状态机。** 现在的删除会先拆席位并清掉 `session_index`，审计运行时随后就
   找不到 JSONL。新流程必须先冻结 Bot、完成终审并收到 Gateway 持久化确认，再物理删除。
3. **评分必须标明是模型评估，不是用户评分。** 当前产品没有用户反馈事件。第一版字段叫
   `modelScore`；将来若加入点赞或人工评分，另存 `userRating`，不能混为一个数字。
4. **每天固定为 3 个不重叠的 8 小时窗口。** 以公司审计时区为准，依次为
   09:00–17:00、17:00–01:00、01:00–09:00。每一轮只进入一个窗口，避免重复总结、
   重复计费和评分口径失真。

---

## 2. 范围

### 2.1 第一版做

- 每个公司、账号、Bot 按固定窗口自动生成审计批次。
- Bot 运行时读取本地会话 JSONL，在后台调用 Gateway 选定的审计模型做结构化总结；默认使用
  任务模型（代码角色 `daily`），用户可以改为 `utility`。
- Gateway 保存每个窗口的覆盖状态和结构化审计条目。
- 公司 `admin` 可以按员工、Bot、时间、结果、分数查询。
- 删除 Bot 时先冻结并补齐截至删除时刻的所有未审计事件，成功后再删除。
- 机器离线、模型失败、Gateway 短时不可用时可幂等重试，不重复生成条目。

### 2.2 第一版不做

- 不把原始 JSONL 搬到 Gateway。
- 不保存完整工具返回、邮件正文、网页正文、附件正文或模型 reasoning。
- 不让审计摘要回流到 Bot 上下文、记忆或 Skill。
- 不用审计分数自动处罚员工、停用 Bot 或触发外部动作。
- 不承诺模型评分等同于事实正确性或人工绩效评价。

---

## 3. 数据边界与隐私

现有不变量“Gateway 不存会话正文”仍保留为：

> Gateway 不保存原始会话事件；只保存经过裁剪、脱敏、有留存期限的结构化审计派生物。

审计条目允许保存：

- 任务摘要；
- 发生时间线（几点几分做了什么）；
- 用户问题的短摘要；
- 模型回答的短摘要；
- 最终结果、结果状态、证据摘要；
- 模型评分、分项、置信度；
- 指向原始会话的 `sessionId + firstSeq + lastSeq`。

审计条目禁止保存：

- 原始完整消息和原始工具返回；
- provider 密钥、连接器 token、cookie、口令；
- 文件正文、邮件正文、网页全文；
- 被 PII 守卫识别出的身份证号、银行卡号、手机号、邮箱等原值。

服务端对单字段设硬上限：问题摘要 500 字、回答摘要 1,000 字、最终结果 500 字、时间线最多
20 项且每项 200 字。运行时先脱敏，Gateway 再做一遍格式、大小和敏感字段校验。审计详情建议
采用应用层信封加密，密钥不进入数据库；首发默认保留 180 天，允许公司在平台限定范围内配置。

公司管理员读取详情本身写入现有 `audit_events`：

- `conversation_audit.list`
- `conversation_audit.read`（带 `auditItemId`，不带内容）
- `conversation_audit.export`（以后做导出时）

Bot 删除不删除这些审计条目。审计表不对 `catalog_items(id)` 建外键，并冗余删除时的 Bot 名称；
否则 Bot 一删，审计记录会被级联删除或只能显示一串悬空 id。

---

## 4. 时间窗口与归属规则

### 4.1 配置

公司设置新增：

```jsonc
{
  "conversationAudit": {
    "enabled": true,
    "timezone": "Asia/Kuching",
    "anchor": "09:00",
    "windowMinutes": 480,
    "modelRole": "daily",
    "retentionDays": 180,
    "promptVersion": 1
  }
}
```

`timezone` 必须是 IANA 时区，不能使用机器当前时区。调度用日历时间计算，夏令时切换日仍以
本地 09:00 为锚点；窗口在库里存转换后的 UTC 毫秒值。

第一版固定要求 `anchor=09:00`、`windowMinutes=480`，服务端不接受其他值。这里保留结构化
字段，是为了让时区和实际窗口口径能被明确记录，不代表公司管理员可以自行改成其他周期。

`modelRole` 只接受：

| 值 | 界面名称 | 行为 |
| --- | --- | --- |
| `daily`（默认） | 任务模型 | 使用平台配置的日常任务模型完成摘要和评分 |
| `utility` | Utility 模型 | 使用平台配置的 Utility 模型，适合更看重成本的公司 |

有审计配置权限的公司用户可以在审计设置中切换，不能提交具体 provider/model，也不能借此绕开
平台模型白名单。批次创建时固化 `modelRole + provider + model + reasoningEffort`；设置变更只影响
之后新建的批次，已经排队或运行中的批次不换模型，避免同一 job 重试时产生不同结果。

被选择的角色尚未配置时，设置接口直接拒绝切换；运行中后来遇到模型被移除时，批次进入重试
并明确报 `audit_model_unavailable`，不静默回落到另一角色。删除终审同样不能用回落模型绕过
用户明确选择的审计口径。

### 4.2 一轮属于哪个窗口

- 只处理 `kind=main` 的会话；委派子会话第一版通过主会话里的 `delegate_task` 结果体现。
- 以匹配的 `turn/end.time` 归属窗口，使用半开区间 `[windowStart, windowEnd)`。
- 跨窗口的一轮只进入结束时所在的窗口，不重复。
- 到窗口关闭时还没有 `turn/end` 的轮次留给下个窗口。
- 删除终审会先让运行时静默并收口；超过静默超时仍未结束的轮次写入
  `outcome=partial`，明确标记“删除时被中止”，不能伪装成完成。
- Gateway 先根据主会话索引的活动时间和消息数判断空时段：整个窗口没有新对话时直接落
  `empty` 覆盖水位，不派发到 Bot、不读取会话正文，也不调用模型，避免每次重启都重新检查。
- 索引显示窗口内有活动、但最终没有完成轮次时，由运行时返回 `empty`；这条兜底同样不调用模型。

### 4.3 时序与水位

Gateway 在窗口结束 5 分钟后创建任务。每个 `(accountId, botId)` 维护已确认的
`coveredThroughSeq`；审计结果必须回传：

- `firstSeq`、`lastSeq`；
- `eventCount`、`turnCount`；
- 窗口最后事件的 SHA-256；
- 本次结构化结果的 SHA-256。

Gateway 只有在批次和条目同一事务提交成功后才推进水位。删除终审从最后确认水位开始扫到
冻结后的最终 `seq`，所以即使前一个定时批次尚未运行，也不会留下空洞。

---

## 5. 运行架构

```text
Gateway 调度器
  └─ 创建 conversation_audit_batches（唯一任务与状态）
       └─ 调用对应 pair 的 Bot /api/audit-jobs/:id
            ├─ 从本地 JSONL 读取窗口事件
            ├─ 规则裁剪、敏感信息脱敏、按大小分块
            ├─ 用批次固化的任务模型或 Utility 模型生成结构化摘要与评分
            └─ PUT /internal/conversation-audits/:jobId/result
                 └─ Gateway 校验归属、范围、大小、哈希并事务落库
```

“由 Bot 运行时后台运行”不等于“由每个 Bot 自己决定几点跑”。时间与完成状态必须由 Gateway
掌握，因为 Gateway 才有唯一数据库、公司时区和重试状态；Bot 运行时只执行审计任务。

第一版复用现有 Gateway routine tick，不再新起一套毫无关系的定时器：

1. tick 计算刚关闭且未建批次的窗口；
2. 对窗口内可能有活动的 `(accountId, botId)` 建批次；
3. 原子 claim 一批 `queued/retry` 任务，写 `leaseUntil`；
4. 通过实例地址和席位票派给 Bot；
5. 超过 lease 没有结果的任务回到 `retry`，按 1、5、15、60 分钟退避；
6. 运行时的结果先进入本地 outbox，Gateway 返回 2xx 才删除 outbox 行。

`jobId` 由 Gateway 生成，所有提交都是 upsert。新旧 Gateway 在升级窗口同时扫描也只能 claim
一次；运行时收到同一个已完成 `jobId` 直接重放本地结果，不重新花一次模型费用。

---

## 6. 结构化结果与评分

每个窗口产生一个批次，批次中可以有 0 到多条“任务审计项”。建议模型输出：

```jsonc
{
  "items": [{
    "itemKey": "reply-supplier-quote",
    "firstSeq": 120,
    "lastSeq": 146,
    "startedAt": 1788239100000,
    "endedAt": 1788239700000,
    "taskSummary": "核对报价并回复供应商",
    "timeline": [
      { "at": 1788239160000, "action": "读取报价附件" },
      { "at": 1788239580000, "action": "发送回复邮件" }
    ],
    "userQuestion": "用户要求核对报价差异并回复供应商。",
    "modelAnswer": "Bot 汇总了三处差异并起草、发送回复。",
    "finalResult": "邮件发送成功；返回消息 ID 的工具结果作为证据。",
    "outcome": "completed",
    "modelScore": 88,
    "scoreBreakdown": {
      "completion": 38,
      "evidence": 22,
      "instructionFollowing": 14,
      "efficiency": 7,
      "communication": 7
    },
    "scoreReasons": {
      "completion": "三处差异都核对并回复了；附件里的第四页没打开，扣 2 分。",
      "evidence": "gmail_send 返回了消息 ID；差异数字没有逐项引用附件原文。",
      "instructionFollowing": "按要求回复了供应商，没有越权改价。",
      "efficiency": "重复读取了一次同一个附件。",
      "communication": "说明了发送结果，但没提没看的那一页。"
    },
    "scoreConfidence": 0.82,
    "evidence": ["gmail_send 返回成功"],
    "riskFlags": []
  }]
}
```

分数为 0–100，只评价这一项任务：

| 维度 | 分值 | 判据 |
| --- | ---: | --- |
| 完成度 | 40 | 用户要求是否全部完成；未完成不可给满 |
| 证据与可靠性 | 25 | 是否有工具结果或用户确认支撑最终结果 |
| 指令与边界遵循 | 15 | 是否遵循用户要求、审批和公司策略 |
| 效率 | 10 | 是否存在明显重复、无关步骤或无效调用 |
| 沟通 | 10 | 回答是否清楚、准确说明完成与未完成项 |

**每一项都要写原因（`scoreReasons`，与 `scoreBreakdown` 同键）。** 只有分数的话，管理员看到
「完成度 30 / 40」却不知道那 10 分扣在哪儿，既没法复核，也没法拿去和员工沟通。原因要引用
对话里的具体事实（哪一步、哪个工具结果、用户怎么说），满分的项也写依据；每项上限 400 字，
Gateway 只收分项里有的键。0042 之前生成的条目没有这一列的内容，界面如实写「没有写原因」。

**每一项的满分跟着条目存（`scoreMax`）**，由席位按它评分时用的那份规则（`SCORE_ITEMS`）填，
不让模型填，也不在界面里另抄一份权重：规则哪天改了，老条目仍按当时的满分画「得分 / 满分」。
只有 0042 之前、一格满分都没带的老条目，界面才按当时那套 40/25/15/10/10 补。

这三格（原因、满分、语言）为默认值时**不进结果指纹**：升级前已经落库的批次，升级后被席位
原样重报，指纹要和当初一样，否则会被当成「提交过不同的结果」顶回去（`auditResultHash`）。

**审计文字的语言跟会话主人走。** 个人设置里的「界面语言」存在账号上（`accounts.locale`），
Gateway 派活时带 `locale: zh|en`，席位的提示词据此要求所有给人看的字段（摘要、时间线、
问题、回答、结果、原因、证据、风险标记）用那种语言写；JSON 键和枚举值不翻。席位回报时带回
`locale`，记在每一条上（`conversation_audit_items.locale`）。语言在派活那一刻取：改了语言之后
还没跑的批次用新的，已经生成的不重写。老席位不认这个字段，照旧写中文、回报时不带，按 `zh` 记。

硬规则优先于模型：

- `turn/end.reason !== completed` 时 `completion <= 20`；
- 对外写操作没有成功工具结果或用户确认时，不允许声称 `completed`；
- 被策略拒绝的动作应写 `blocked`，不是 `failed`；
- 没有实际任务的问答可以生成简短审计项，但 `outcome=answered`，不套用“任务完成度”评分；
- 评分模型、提示词版本、脱敏版本全部落库，便于以后圈定重评。

执行仍在该 Bot 运行时，但摘要和评价使用批次固化的平台角色模型：默认是任务模型 `daily`，
用户可以在审计设置中改为 `utility`。它不是让正在被审计的对话继续运行，也不会调用工具；
评分只用于审计筛选和人工复核，不作为自动绩效结论。界面必须显示本批次实际使用的角色和
具体模型，避免切换后无法解释分数差异。

---

## 7. Gateway 数据模型

新增迁移建议命名 `0027-conversation-audits.ts`：

### 7.1 `conversation_audit_batches`

一行代表一个 Bot 的一个审计窗口或一次删除终审。

关键字段：

- `id`
- `companyId`、`accountId`、`botId`（不对 Bot 建外键）
- `deletionRequestId`（仅删除终审批次有值；一次删除可能对应多个账号席位）
- `sessionId`
- `kind`: `scheduled | pre_delete`
- `windowStart`、`windowEnd`、`timezone`
- `fromSeq`、`toSeq`、`eventCount`、`turnCount`
- `status`: `queued | leased | processing | succeeded | empty | retry | dead`
- `attempts`、`leaseUntil`、`nextTryAt`、`lastError`
- `modelRole`、`model`、`reasoningEffort`、`promptVersion`、`redactionVersion`
- `sourceHash`、`resultHash`
- `createdAt`、`startedAt`、`completedAt`

唯一索引：

```sql
unique ("accountId", "botId", kind, "windowStart", "windowEnd")
```

并为调度建立 `(status, nextTryAt)` 部分索引，为管理员列表建立
`(companyId, windowEnd desc, id desc)` 索引。

### 7.2 `conversation_audit_items`

一行代表批次中的一个任务或回答。关键字段：

- `id`、`batchId`
- 冗余 `companyId`、`accountId`、`botId`、`sessionId`，便于查询与 Bot 删除后显示
- `botNameSnapshot`、`accountNameSnapshot`
- `itemKey`、`firstSeq`、`lastSeq`、`startedAt`、`endedAt`
- `taskSummary`
- `timeline` JSONB
- `userQuestion`、`modelAnswer`、`finalResult`
- `outcome`: `completed | partial | failed | blocked | answered | unknown`
- `modelScore`、`scoreBreakdown` JSONB、`scoreConfidence`
- `evidence` JSONB、`riskFlags` JSONB
- `createdAt`、`expiresAt`

唯一索引 `(batchId, itemKey, firstSeq, lastSeq)`。所有文本均在 Gateway route 层二次截断，
不能只相信运行时或模型遵守上限。

### 7.3 `bot_deletion_requests`

- `id`、`companyId`、`accountId`、`botId`（全局/公司旧 Bot 跨账号删除时 `accountId` 可为空）
- `botNameSnapshot`、`requestedBy`
- `status`: `freezing | auditing | ready_to_purge | purging | completed | failed`
- `cutoffAt`
- `targetCount`、`auditedCount`（删除涉及多少个 pair、已有多少个终审批次成功）
- `attempts`、`nextTryAt`、`lastError`
- `requestedAt`、`auditCompletedAt`、`deletedAt`

同一个 Bot 只允许一条未结束请求，使用部分唯一索引防止用户连点产生多个终审任务。
员工自建 Bot 通常只有一个目标 pair；全局或公司旧 Bot 可能部署给多个账号，需为每个
`(accountId, botId)` 建一个 `pre_delete` 批次。全部目标都为 `succeeded/empty` 后才能进入
`ready_to_purge`，不能用一个席位的成功掩盖其余席位的缺口。

目录项需要一个可查询的删除态。建议给 `catalog_items` 增加 nullable `deletingAt`，而不是把
状态藏进 `definition` JSON。`botsFor` 默认排除 `deletingAt is not null`，管理员删除进度接口
仍能单独查询这条记录。

---

## 8. 接口

### 8.1 公司管理员

```text
GET /orgs/:id/conversation-audits
    ?accountId=&botId=&from=&to=&outcome=&scoreLte=&cursor=
GET /orgs/:id/conversation-audits/:itemId
GET /orgs/:id/conversation-audit-coverage
GET /orgs/:id/conversation-audit-settings
PATCH /orgs/:id/conversation-audit-settings   { "modelRole": "daily|utility" }
```

上述接口都要求 `requireOrg(..., true)`。列表只返回短摘要；详情才解密问题、回答和最终结果。

列表分页：`limit` 上限 200，界面一页带 20；**不带 `limit` 时给 100 条**——那是打包在旧版桌面端
里、没有翻页的老界面，给少了它就只看得到最新那一页。响应带 `hasMore` 和 `nextCursor`（上一页最后一条的
`结束时间:id`），下一页把它原样放进 `cursor`。用游标不用 offset：翻页的同时新批次还在落库，
offset 会让同一条出现在两页上。排序是结束时间倒序、id 倒序，游标按这一对比较，结束时间相同的
几条不会在页边上丢或重。这个排序键有自己的表达式索引（迁移 0042 的
`conversation_audit_item_company_at`），游标条件直接落在索引上。
`coverage` 展示每颗 Bot 最近成功窗口、欠缺窗口、最后错误，避免管理员把“没有日志”误解成
“没有对话”。

设置读写同样要求公司审计管理权限。PATCH 只允许选择角色，不允许修改平台角色对应的
provider/model；响应返回归一化后的角色和当前实际模型。修改成功写
`conversation_audit.model_role.update` 操作审计，只记录 `from/to`，不记录任何会话内容。

### 8.2 运行时上报

```text
POST /api/audit-jobs/:jobId             Gateway 派发；席位票保护
PUT  /internal/conversation-audits/:jobId/result
GET  /internal/conversation-audits/:jobId
```

上报接口按现有 `requireInternalCaller` 口径校验席位票，并额外检查：

- 票对应 `accountId` 必须等于批次账号；
- 环境中钉住的 `SATUWORK_BOT_ID` 必须等于批次 Bot；
- body 的 seq 必须落在批次允许范围；
- 批次已经成功时，只有相同 `resultHash` 可作为幂等重放，冲突内容返回 409；
- 请求体和每个字段都有硬大小限制。

### 8.3 删除

```text
DELETE /runtime/bots/:id                  -> 202（从未有会话时可在 empty 终审落库后直接 200）
GET    /runtime/bot-deletions/:requestId  -> 删除进度
```

重复删除同一 Bot 返回现有未完成请求，不新建。前端将 Bot 从可聊天名册移除，同时显示“正在完成
删除前审计”；失败时显示可重试原因，而不是提示“已删除”。

旧的公司/平台 legacy Bot 删除路由也要走同一服务，不能只改员工自建 Bot 的一条路径。

---

## 9. 删除状态机

删除请求不在一个 HTTP 请求里等待模型调用，完整顺序如下：

1. `DELETE` 在事务里锁定 Bot，写 `deletingAt` 和 `bot_deletion_requests(freezing)`，并写
   `bot.delete.requested` 审计事件；通常返回 202。若从未有会话，服务端先同步落一笔 `empty`
   终审；没有待运行的审计任务时可直接完成删除并返回 200。
2. Gateway 立即停止该 Bot 的新消息、部署、配置修改和 routine 调度。已有 routine 改为不再
   claim，但定义暂时保留。
3. Gateway 向运行时发送 quiesce：拒绝新轮次，允许正在运行的一轮正常收口。
4. 超过删除静默上限仍未收口时，运行时取消该轮并保证写入
   `turn/end(reason=aborted)`；随后固定 `cutoffSeq`。
5. 为这颗 Bot 当前的每个目标 pair 创建 `kind=pre_delete` 批次，各自从最后已确认水位审计到
   冻结后的 `cutoffSeq`。它必须覆盖所有尚未成功的定时窗口，不能只审计“当前 8 小时”。
6. 运行时完成脱敏、总结和评分，Gateway 事务落库并回 2xx。
7. 只有所有目标 pair 的批次均为 `succeeded/empty` 后，请求才进入 `ready_to_purge`。
8. 调用现有 `purgeBot` 拆席位、清实例、会话索引、私有 Skill、routine 和目录项。
9. 席位拆除失败仍可沿用现有墓碑策略，因为此时审计已经安全落在 Gateway；请求记
   `completed` 并保留 `orphans`。
10. 写 `bot.delete.completed`，detail 只带 requestId、batchId、覆盖 seq 和 orphan 席位，
    不带审计内容。

**机器离线时绝不能先删 Bot。** 请求停在 `auditing` 并退避重试。这样会牺牲“立即删除”的
体验，但这是“删除前必须审计”的直接含义。若业务以后需要强制删除，必须另设计仅平台 owner
可用的显式豁免动作，并写 `bot.delete.audit_waived`；第一版不提供静默绕过。

Gateway 或 Bot 重启后都从持久化状态恢复：Gateway 扫未完成删除请求，运行时从本地 outbox
重发结果。任何一步都不能只存在内存里。

---

## 10. 失败、成本与容量控制

- 空窗口由 Gateway 先判空并跳过派发；无法在索引侧确定时才交给 Bot 核验，二者都不调用模型。
- 一批输入超过上限时按完整 turn 分块；每块独立总结，最后再做一次合并。不能从中间截断
  user/assistant/tool 序列。
- 每个 Bot 同时最多一个审计任务；每台机器设置并发上限，避免窗口关闭时所有 Bot 同时抢模型。
- 审计调用走现有 `/v1/*` 计费链路，新增 `purpose=conversation_audit` 或等价维度，管理员可从
  账本区分聊天、任务抽取和审计成本，并按 `daily/utility` 比较费用。
- 普通失败按封顶退避持续重试，不能在固定次数后永久静默；`dead` 只表示该普通批次已被
  删除终审明确接管。管理员 coverage 页面显示错误与缺口，删除终审不能进入 dead 后继续删除。
- prompt injection 按任务抽取同一原则处理：邮件、网页、工具返回都是资料，不是 evaluator
  指令。模型输出只进入展示表，不能触发工具或执行路径。
- 评分与摘要模型不可用时，定时批次重试；不能把未评分内容伪装成成功。若产品允许“有摘要
  无评分”，需要把状态拆成字段，不可用默认分数 0 代替。

---

## 11. 管理员界面

审计页只保留 **审计总结**，不再向公司管理员展示原始对话索引或管理员操作记录。总结列表
展示任务摘要、员工、Bot、结果、模型评分和结束时间，并支持按开始日期、结束日期、员工、Bot
组合筛选。筛选必须下推到 Gateway 查询，不能只过滤浏览器当前拿到的一页。列表一页 20 条，
底下是「第 N 页 / 上一页 / 下一页」（游标栈，和计费明细同一种做法）；换筛选条件回到第一页。
从某条总结的详情页回来留在原来那一页，从侧栏或别的页进来回到第一页——旧游标是按当时的
结果算的，接着翻会跳过这期间新落库的那些。

员工与 Bot 下拉项来自审计条目保存的名字快照，而不是只读当前账号和 Bot 名册。这样员工离职
或 Bot 删除后，历史总结仍可按原来的对象筛选。

对话摘要详情显示：

- 时间范围和审计生成状态；
- 本批次使用的任务模型或 Utility 模型；
- 按实际时间排序的动作时间线；
- 用户问题摘要、模型回答摘要、最终结果；
- 总分、置信度和“模型评估”标签；
- 评分明细：每一项的名称、得分 / 满分和得分原因；
- 脱敏、缺失或部分完成提示。

页面必须显示 coverage。只显示成功条目会产生危险错觉：管理员看到空白，无法分辨当时没有对话，
还是机器离线导致审计没跑。

---

## 12. 代码拆分建议

### Gateway

- `gateway/src/db/migrations/0027-conversation-audits.ts`：三张表和 `catalog_items.deletingAt`
- `gateway/src/db/types.ts`、`rows.ts`、`db.ts`：批次、条目、删除请求及原子 claim
- `gateway/src/conversation-audit.ts`：窗口创建、派发、lease 回收、删除状态机
- `gateway/src/routes/internal.ts`：运行时结果上报
- `gateway/src/routes/sessions.ts`：公司管理员列表、详情、coverage
- `gateway/src/routes/runtime.ts`、`routes/catalog.ts`：删除改为 202 状态机
- `gateway/src/routines.ts`：在已有 tick 中调用 audit/deletion tick，或抽出共享 scheduler tick
- `gateway/ui/pages-audit.js`、`app.js`、`state.js`：单一总结列表、筛选、详情、coverage

### Bot

- `bot/src/conversation-audit/index.ts`：任务接收、JSONL 窗口读取、裁剪、脱敏、模型调用、outbox
- `bot/src/session/types.ts`：若需显式记录删除中止原因，只扩展 `turn/end` 的兼容字段；不新增正文
  事件类型
- `bot/src/web/index.ts`：审计任务与删除静默端点
- `bot/cordis.yml`：在 session、catalog、llm 之后挂载审计插件

自动审计的水位必须独立表示“是否已持久化覆盖”，并按自己的失败语义和删除约束推进。
turn 切分、非流式模型调用、JSON 解析和 outbox 可以复用通用实现，但不能共用状态。

---

## 13. 分阶段实施

### 阶段 A：契约与存储

- 冻结时间窗口、评分 rubric、字段上限和留存策略。
- 落三张表、DB API、管理员只读接口。
- 写 payload schema 与 prompt version，先用 fixture 验证，不接调度。

### 阶段 B：运行时抽取

- 新增 Bot 插件，完成事件切窗、脱敏、空窗口判断、按批次模型角色总结和本地 outbox。
- 新增内部上报接口及双重归属校验。
- 手动创建批次，跑通一次端到端并核对 seq 覆盖。

### 阶段 C：自动调度与界面

- 接入 Gateway tick、claim/lease/retry，以及删除终审接管普通批次的终止状态。
- 实现公司管理员摘要页、详情页和 coverage。
- 加入审计模型调用的独立计费维度和容量限制。

### 阶段 D：删除终审

- 删除改为冻结 + 202 + 进度查询。
- 接入 quiesce、最终 seq、`pre_delete` 批次和成功后 purge。
- 同时覆盖员工 Bot 与 legacy/company/global Bot 的删除入口。

### 阶段 E：灰度与回填

- 先对内部测试公司启用，只处理启用后的新窗口，不默认回填全部历史。
- 比较模型摘要与原始会话，校准 rubric 和脱敏误伤率。
- 观察每 Bot 每日 token、失败率、窗口延迟和 Gateway 存储增长，再逐公司放开。

---

## 14. 必测场景

1. 09:00 边界两侧的 turn 只进入一个窗口；跨午夜和 DST 不重复、不漏。
2. 同一 job 重复派发、重复上报只产生一批条目，不重复计费。
3. 窗口无对话时由 Gateway 直接记 `empty`，不派发 Bot 且不调用模型；索引无法确定时由 Bot 兜底判空。
4. 超长单轮和多轮分块不切断 tool call/result 配对。
5. 运行时在总结后、上报前崩溃，重启从 outbox 重发。
6. Gateway 在落库后、回 2xx 前崩溃，重放命中相同 hash。
7. 恶意席位不能替另一账号或另一 Bot 上报审计。
8. 模型输出超长、非法 JSON、越界 seq、含明文敏感信息时拒收并持续退避重试。
9. 删除空闲 Bot：终审成功后删除，审计条目仍可查。
10. 删除正在运行的 Bot：先静默，正常收口或明确 aborted，再终审。
11. 删除时机器离线：Bot 不物理删除，恢复在线后继续终审并完成删除。
12. 终审成功后拆席位失败：Bot 删除完成、席位留墓碑、审计仍完整。
13. 定时批次正在处理中又发起删除：终审覆盖水位缺口，不漏、不重复。
14. 管理员读审计详情会新增 `conversation_audit.read` 操作记录，普通成员拿不到数据。
15. Bot 删除、账号停用、Gateway/运行时升级重启都不丢未完成批次和删除请求。
16. 默认批次使用任务模型 `daily`；切换为 `utility` 后只有新批次改变，旧 job 重试仍使用原模型。
17. 所选模型角色未配置或已移除时明确失败，不静默回落；删除终审保持等待而不是越过审计删除。

---

## 15. 验收标准

- 任意成功批次都能证明其覆盖的 `sessionId + seq` 范围，且同一完成轮只归属一个定时窗口。
- Gateway 数据库中不存在原始会话事件、完整工具返回或未脱敏密钥；审计文本全部受字段上限约束。
- 管理员能区分“没有对话”“审计成功”“审计延迟/失败”“删除终审中”。
- 未完成删除终审时，任何代码路径都不能调用 `db.deleteBot`。
- `db.deleteBot` 之后，Bot 的历史审计项仍能按快照名称查询。
- 所有模型分数明确标注为模型评估，并保留模型、提示词和评分版本。
- 默认使用任务模型，用户可切换到 Utility；每个批次都能追溯选择的角色和实际模型。
- 自动调度、重试、Gateway 重启和运行时重启均不会造成重复审计条目或重复删除。
