# Satuwork：计费账本、缓存定价与熔断

这份文档记的是**为什么是这个形状**。它要解决的那件事一句话能说清：钱曾经只记在三个
互不相识的地方，而且一分都没真扣过。

现在：模型（含缓存读写）、连接器、网页搜索都按次落在**一张账本**上，实时从「套餐赠送
→ 账户余额」里扣，两个桶都空了就熔断这家公司所有要收钱的调用。

前置阅读：[docs/connectors.md §8 计费](connectors.md)、[docs/web-tools.md](web-tools.md)。
那两份里定下的口径（微元、先赠送后充值、写行即定价、允许小额透支）这里全部沿用，
不重新论证；这份只写它们没覆盖的部分。

---

## 1. 改之前是什么样

三条会花钱的路，各自走到哪一步——**下面这张表是历史**，留着是因为每一条缺口都对应
后面的一个设计决定：

| | 记流水 | 记金额 | 扣余额 | 余额不足拦截 | 单次历史可查 |
|---|---|---|---|---|---|
| **模型调用**（`/v1/*`） | ✅ `llm_calls` | ❌ 只记 token | ❌ | ❌ | ❌ |
| **连接器**（`/mcp/connectors/*`） | ✅ `connector_calls` | ✅ `amountMicros` / `bonusMicros` | ✅ 现算 | ✅ | ❌ 只有汇总 |
| **网页搜索 / 提取**（`/runtime/web/*`） | ✅ `web_calls` | ✅ `mils` | ❌ | 只有 `dailyLimit` 次数闸 | ❌ 只有汇总 |

由此的五个缺口，也就是这次要补的五件事：

1. **模型没有缓存写单价，也没有缓存写 token。** `llm_calls` 有 `cachedTokens`（缓存读），
   没有缓存写。而 `v1.ts` 的 `usageFromPayload` **算出了** `cache_creation_input_tokens`
   却只把它并进 `prompt_tokens` 就丢掉了。Anthropic 的缓存写是输入价的 1.25 倍，被当成
   普通输入算，每次写缓存都少收两成半。
2. **自定义模型的缓存单价填不进去。** `providers.ts` 的 `parseModelDef` 早就收
   `cacheRead` / `cacheWrite` 了，但界面那份表单把这两项写死成 0。于是自定义供应商的
   模型永远没有缓存价，落到 `/platform/stats` 里那条 `Number(c.cacheRead) || input`
   兜底上——按输入价收，高估十倍。
3. **模型调用不扣余额，也不熔断。** `lib/billing.ts` 的 `balanceOf` 上写着「消耗还没接」。
   连接器是唯一真的往下扣的东西，而它只看自己那张表：一家公司把钱全烧在模型上，
   连接器那边算出来的余额纹丝不动。
4. **金额算法有两套，而且一套会追溯改账。** 连接器和网页工具是**写行时定价**，
   `/platform/stats` 的模型金额是**查询时按当前单价现折**。改一次倍率，上个月的模型
   账单跟着变，而同一张表里连接器那一列不变。
5. **没有单次调用的计费历史。** 三个 `*-stats` 接口全是 `group by` 之后的汇总。
   「这个月为什么是 $37」这个问题，今天没有任何一个接口回答得了。

---

## 2. 两条定死的口径

**一、账本是唯一的钱。** 新开一张 `usage_charges`，三条路的每一次计费调用往里落一行。
`connector_calls.amountMicros` / `web_calls.mils` 变成只读的历史列，不再写入
（见 §11 的切换顺序）。理由：余额 = 充的 − 花的，而「花的」要横跨三种调用；
三张表各存各的，就意味着每次熔断判定要发三条 `sum`，而且它们永远有一条会被人忘了改。

**二、金额在写行那一刻定死，之后只 `sum`，绝不重算。** 这是把模型那套改成连接器那套，
不是反过来。理由 `connectors.md §9` 已经写过：单价是我们改得动的东西，重算意味着
上个月的账单每天都不一样。代价是历史行留着当时的单价和倍率快照——那正是「查得到单次
调用为什么收这么多」所需要的东西。

### 2.1 唯一的例外：把清扫的占位行补成成交

**只有一处可以改一行已经落下的账**，边界写在这里，代码在 `db.fillPlaceholderCharge`
和 `lib/llm-billing.ts` 的 `fillSweptCharge`：

> 管家拿了授权却在 `LLM_SETTLE_GRACE_MS`（30 分钟）里没回来结算时，清扫
> （`routines.ts` 的 `sweepUnsettledLlmCalls`）会先把这一次按 `failed` / 0 元 /
> `unpriced` 收了口。**管家随后带着真实用量回来时，那一行可以被补成真的成交。**

这不违反上面那条，因为它改的**不是一笔成交价，是一行从来没有成交过的占位**。原来的
处理是幂等一挡到底：不收第二笔钱——可它连带着把第一笔也钉死成 0。于是一通真金白银
发生过的调用，账上永远是 0，而且**事后补不回来**：用量只存在于管家这一次回调里，
错过就没了。一次长回答带工具调用跑过半小时并不罕见，漏的是真钱。

判据严到只认清扫写出来的那个形状，一格都不能松：

    refId 指着这一次调用 · kind = llm · status = failed · unpriced
    · amountMicros = 0 · bonusMicros = 0 · 四项 token 全 0

少一格就可能盖掉一笔真收过的钱：`denied`（闸拒的，是事实）、金额非 0 的（已经成交）、
带用量的（已经结过）各自都会因为某一格对不上而落空。对不上就一行都不动，退回原来的
「只补 token」（`recordUsageOnly`），接口回 `{ settled: false, reason: 'already' }`。
补上了回 `{ settled: true, reason: 'filled' }`。

另外三条边界，各自都踩过一次才写下来：

- **是 `update` 不是 `delete + insert`。** 账本只增不改是这张表的性格，破口子也要破得
  最小：行还是那一行、id 还是那个 id，只是不再说假话。原子性由 `where` 里那串判据
  保证——两个并发的补录，第二个的 `where` 已经对不上，回 0 行。
- **`createdAt` 不动。** 那是清扫写下的时刻，比「管家什么时候想起来回来」更接近调用
  真实发生的时间；改它会把这笔钱挪到另一个账期去。
- **赠送桶要看账期。** 占位行的时间戳可能落在上一个账期里，而赠送额度的上限只数当期
  （`createdAt >= since`）。给一行上一账期的行记了 bonus，这笔 bonus 不进后续的 `sum`，
  赠送桶会被扣穿——所以补录的 SQL 在 `least/greatest` 外面还套了一层
  `case when u."createdAt" >= since`，跨期的一律走充值桶。
- **上游一个 token 都没报就不补。** 补出来的还是一行 0 元 `unpriced`，白折腾一次写，
  还多一次把判据擦边的机会。

**单位一律微元**（micros，百万分之一美元）。余额那边是厘（mils），换算只有一处：
`1 mil = 1000 micros`。网页工具现在记的是厘，回填时 ×1000。

---

## 3. 缓存价格

### 3.1 模型单价是四项，不是两项

```ts
interface ModelRate {
  input: number       // 未命中缓存的提示词，每 100 万 token 多少美元
  output: number
  cacheRead: number   // 命中缓存读出来的那一截
  cacheWrite: number  // 这次写进缓存的那一截（Anthropic ≈ input × 1.25）
}
```

单位沿用 pi-ai 内置目录的口径。**这四项本来就都在** `CustomModelDef.cost` 里
（`providers.ts` 的 `CustomModelDef.cost`），缺的是界面和计价。

### 3.2 计价公式

```
fresh   = max(0, promptTokens − cachedTokens − cacheWriteTokens)
micros  = round( (fresh × input
                + cachedTokens × cacheRead
                + cacheWriteTokens × cacheWrite
                + completionTokens × output) × multiplier )
```

**没有除以一百万。** 单价是「每 100 万 token 多少**美元**」，账本是**微元**，
两个一百万正好抵消：1 token × r 美元/1M tok = r 微元。这条巧合值得写在代码注释里——
不写的话下一个人会补一个 `/ 1_000_000`，然后所有模型账单变成零。

`promptTokens` 含缓存读和缓存写（`v1.ts` 的 `usageFromPayload` 对 Anthropic 是
`input + cacheRead + cacheWrite`，对 OpenAI 本来就含缓存读、且没有缓存写），
所以 `fresh` 要把两截都减掉。三个 `max(0, …)` 是防脏数据的，不是防逻辑错。

### 3.3 单价从哪来

**逐字段**四层回落（`lib/pricing.ts` 的 `rateOf`）：

1. **平台覆盖**：`platformSettings.modelPricing["provider/model"]`，一张可选的四项表。
   用来干两件事——给 pi-ai 没收录价格的模型（zai 这些，目录里全是 0）补价，以及在上游
   调价时不等 pi-ai 发版就先改过来。
2. **目录里的 `cost`**：pi-ai 内置的，或自定义供应商 / 公司目录里自己填的。
3. **平台兜底**：`platformSettings.defaultModelRate`，同样是四项，运营在模型配置页的
   「单价倍率」那一块里填。它**压在目录价下面**，不是盖在上面——配了兜底之后已经有价的
   模型照旧按自己的价收，只有前两层都查不到的才落到它头上。
4. **仍然缺的缓存两项 → `input`**：宁可高估，也不要因为缺一列就把这部分白送。
   `cacheWrite` **不**回落到 `input × 1.25`，那个系数是 Anthropic 一家的定价习惯，
   写进通用兜底就是把某一家的价目表编死在代码里。
5. **合出来 `input` 和 `output` 缺任意一侧 → 不计价**：金额记 0，账本行上打
   `unpriced: true`。这是配置问题，界面要喊出来，不要在计价里悄悄编一个数。

> **为什么是「缺一侧就不算」，而不是「缺的那侧回落到另一侧」。** 踩过一次：收口条件
> 曾经是「两侧都是 0 才不计价」，于是一颗「目录里有 input、没 output」的模型（自定义
> 供应商那张表单的四个价格框只填了第一个，就是这个形状）算「有价」——`llmMicros` 照着
> 那个 0 把输出 token 乘成 $0。输出通常是输入的 3–5 倍，等于**只收了四分之一**。
>
> 而这一刀真正的分量在另一半：那时 `unpriced` 是 **false**，`unpricedModels` 不响、
> `unmeteredModels` 不响、模型表和统计屏的角标都不画、`chargeable` 返回 true 余额闸
> 照判——整条链上没有一处看得出少收了钱。**不喊出来的低估，比喊出来的零更难查。**
>
> 回落到另一侧（output 缺了就按 input 收）解决不了这个：按 input 收输出仍旧是低估，
> 而且 `unpriced` 会继续是 false，一句提示都不响，换汤不换药。要接住这批模型的是
> 第 3 层——运营填的兜底逐字段回落，配上之后缺的那一侧自动补齐，这一颗就正常计价了。
>
> 代价说清楚：没配兜底时，这类模型连原先还能收到的那半边 input 钱也不收了（收 0）。
> 但它会**喊出来**——统计屏一句「目录里没有单价」，模型表里画「—」，owner 去配置页
> 补上单价或兜底。比起从前那个既少收又不喊的状态，这是往前走的。

> **为什么要有第 3 层。** 没有它的时候，查不到价的调用记的是金额 0 + `unpriced`，
> 而那个 0 的本意是「算不出来」——可它在账单上和「免费」长得一模一样，月底真扣的钱就
> 少了那一截，少掉的那截没有任何一屏对得出来（统计屏只能事后喊一句「金额不完整」）。
> **宁可按一个说得清来路的估价收，也不要收零。**
>
> 兜底和「代码自己编一个数」不是一回事，界线就在**来路**上：兜底是运营在配置页上填的，
> 填多少、什么时候改都在那一屏上看得见；代码里凭空算一个数没人知道它从哪来，却会被
> 当成成交价。所以 `meter.quote` 那句「不编一个数」照旧成立——不编数这件事由 `rateOf`
> 的最后一层（运营填的兜底）来办，不由计价代码来办。
>
> 兜底一旦设上，这批模型就**是要钱的**：`chargeable` 跟着返回 true，余额闸照常判
> （以前它们一律放行，因为收的是 0）。
>
> 界面上要看得出哪些模型在吃兜底：模型表里这类行的两列单价画成虚下划线的浅色，改价
> 弹层的占位符也落到兜底价——占位符仍旧写 0 的话，那一屏等于在说「留空就是免费」。

> **覆盖是按字段盖的，不是整份顶掉。** 这一条踩过：曾经是「覆盖里有任意一项非零就整份
> 用它」，而改价弹层的四个框默认留空（故意不预填目录价，否则一按保存就把目录价抄成了
> 覆盖，上游再调价也不会跟着动）。于是只想修一项缓存单价的人填完保存，`input` 和
> `output` 就成了 0——那个模型从此按 $0 计费，`unpriced` 还是 false，所有提示都不响。
> 按字段盖之后，留空就是「这一项用目录价」，和占位符说的是同一件事。

代价：**0 一律读作「没填」，不是「这一项免费」**。整份计价都是这个约定（目录里没收录
价格的模型四项也是 0，兜底的四项留空也是 0）。要真按 0 收，得区分「填了 0」和「没填」，
而那个区分在一个数字输入框上表达不出来。兜底也一样：`input` / `output` 缺哪一侧，它就
补不上哪一侧，两侧都留空就是彻底「不兜底」，行为回到第 5 条。

另一个代价：缓存读回落到输入价时会高估十倍。所以界面上把「回落来的价」画成虚下划线
加悬浮说明——高估收到公司头上比白送更难解释，而唯一能挡住它的是有人看见。

### 3.4 落在哪几处

- `llm_calls` 多一列 `cacheWriteTokens`（迁移 0008）。
- `v1.ts`：`TokenUsage` / `PartialUsage` / `mergeUsage` / `usageFromPayload` / `openaiUsage`
  各多一项缓存写。**`openaiUsage` 把它加进 `prompt_tokens`**——它和缓存读一样是这次
  真发出去的提示词；只加缓存读的话，`fresh = prompt − cached − written` 会把一部分
  未命中的输入当成缓存写来计价，而缓存写比输入还贵。
  但它**不上线**（不出现在响应体里）：OpenAI 的 usage 里没有这个字段，塞一个自造的键
  进去，下游按 OpenAI 口径解析的东西会看到一个它不认识的数。
- `ui/render.js` 那份自定义模型表单不再把 `cacheRead` / `cacheWrite` 写死成 0。
- `ui/pages-admin.js`：单价那两列从两个数变成四个（缓存那截画成第二行），**回落来的价
  画成虚下划线 + 悬浮说明**——看不出是回落的话，一个高估十倍的价会一直收下去；
  每行多一颗「改价」，写的是 `modelPricing` 覆盖。那份 `hasRates` 是**服务端 `rateOf`
  收口条件的镜像**（两项都得有），必须跟着它走——对不上的时候，没人会先怀疑界面。

---

## 4. 计费适配器

`gateway/src/lib/meter.ts`。在这之前三条路各写各的：连接器在 `mcp.ts` 里有自己的
`budgetOf` 和 `priceMicrosOf`，网页工具在 `web-service.ts` 里有自己的 `quoteMils` 和
`meter`，模型那条什么都没有。适配器把它们收成同一套动作。

```ts
/**
 * 一次计费调用的事实。**判别联合，不是一个带一堆可选字段的大对象**——
 * `quote()` 按 kind 分支，漏掉一支编译就过不去。
 */
export type Billable =
  | { kind: 'llm';       account; status; provider; model; tokens: LlmTokens; cost: unknown; refId? }
  | { kind: 'connector'; account; status; toolkit; tool; free?: boolean;      refId? }
  | { kind: 'web';       account; status; backend; webKind; units: number;    refId? }

/**
 * 闸要判断的那件事，和 Billable 分开：**闸在调用发生之前**，那时候还没有计量
 * （模型那条尤其——跑完才知道用了多少 token），只有「这一类现在收不收钱」。
 */
export type GateSubject =
  | { kind: 'llm'; provider; model; cost }
  | { kind: 'connector'; toolkit }
  | { kind: 'web'; backend; webKind }

export class Meter {
  /** 两个桶各还剩多少。带 1 秒记忆，落账时就地扣减。 */
  budget(companyId: string): Promise<Budget>

  /** 平台改了套餐、充了值：那家的记忆当场作废。 */
  forget(companyId: string | null): void

  /**
   * 事前闸。余额还有就放行，没有就说清楚。
   *
   * 返回值而不是抛异常：三条路对「拒绝」的表达方式不一样——模型那条要 402，
   * 连接器和网页工具要一句给模型看的人话。谁来拒由调用方决定，这里只回答「能不能」。
   */
  gate(account: Account, subject: GateSubject): Promise<{ ok: true } | { ok: false; reason: string }>

  /** 报价。算法在 lib/pricing.ts（纯函数），这里只负责把单价取出来。 */
  quote(b: Billable): Promise<Quote>   // { amountMicros, unitPrice, multiplier, unpriced }

  /**
   * 落账。写一行 `usage_charges`，顺带把这一笔在两个桶之间分好。
   * 被拒的也落（amountMicros = 0）——「谁想调、为什么没调成」和「谁调了」一样要留档。
   */
  charge(b: Billable, q?: Quote): Promise<UsageCharge>
}
```

调用方的形状因此统一成三步：

```ts
const credit = await meter.gate(account, subject)
if (!credit.ok) { /* 各自的拒绝方式 */ }
// …真正干活…
await meter.charge(billable)
```

**为什么不做成 `meter.run(fn)` 那种包一层的写法**：三条路对「什么算跑过了」的判定各不
相同——连接器是「provider 返回即计费、抛出即不计费、超时另算」，模型是「拿到 usage
才知道多少钱，断流也要记」，网页工具是「命中缓存不计费、部分失败按成功条数算」。
包进一个高阶函数里，这三种判定会变成三个布尔参数，比现在更难读。适配器统一的是
**数据形状和落账口径**，不是控制流。

---

## 5. 账本表

```sql
create table usage_charges (
  id            text primary key,
  "companyId"   text,                 -- null = owner 自己的调用，记账但不扣（没有公司余额）
  "accountId"   text not null,
  "botId"       text,
  "sessionId"   text,
  kind          text not null check (kind in ('llm', 'connector', 'web')),
  -- 收费对象的字面量。连接器下架了、模型从目录里删了，上个月的账还得看得懂。
  subject       text not null,
  status        text not null check (status in ('ok','failed','timeout','denied','error')),
  -- 计量明细。kind 决定里面有什么：llm 四项 token，connector 空，web { units }。
  quantity      jsonb not null default '{}',
  -- 写行那一刻的单价快照。这是「为什么收这么多」唯一说得清的地方。
  "unitPrice"   jsonb not null default '{}',
  multiplier    real not null default 1,
  -- 这一笔一共多少微元，其中多少由套餐赠送承担。差额 = 充值承担。
  "amountMicros" bigint not null default 0,
  "bonusMicros"  bigint not null default 0,
  -- 没查到单价：金额是 0，但那不等于免费。界面要据此喊出来。
  unpriced      boolean not null default false,
  -- 指回 llm_calls / connector_calls / web_calls 的那一行，用来查 token、耗时这些事实。
  "refId"       text,
  "createdAt"   bigint not null
);
create index usage_company_time on usage_charges ("companyId", "createdAt" desc);
create index usage_account_time on usage_charges ("accountId", "createdAt" desc);
create index usage_company_kind on usage_charges ("companyId", kind, "createdAt" desc);
```

**为什么是一张表而不是三张各加金额列**：熔断判定在每一次模型调用的热路径上。一张表
一条 `sum`，三张表三条 `sum` 加一次加法，而且第四种计费调用出现时（真会出现——
文档提取、桌面时长）还得再加一条，加漏了就是白送。

**为什么 `quantity` / `unitPrice` 用 jsonb 而不是摊成列**：摊开是 `input / output /
cacheRead / cacheWrite / units` 五列，其中任何一行只用得上其中两三列，剩下的全是 0，
而且新增一种计费方式就要加一次列。这两个字段只被「查一行的明细」读，不参与聚合，
不需要索引——正是 jsonb 该待的地方。

**领域表不动。** `llm_calls` 还是记 token、`connector_calls` 还是记耗时和 `viaMention`、
`web_calls` 还是记条数和后端。账本只管钱，事实还在各自的表里，靠 `refId` 串起来。

---

## 6. 扣费顺序与熔断

### 6.1 顺序

**先套餐赠送，再账户余额。** 沿用 `connectors.md §8` 的理由：赠送跟着套餐到期作废，
充值不过期；反过来扣等于逼公司先花光不过期的那笔，然后眼看赠送过期。

```
赠送还剩 = max(0, planBonusMils × 1000 − sum(bonusMicros where createdAt ≥ 本账期起点))
充值还剩 = max(0, topupMils × 1000 − sum(amountMicros − bonusMicros))       -- 全部历史
可用余额 = 赠送还剩 + 充值还剩

bonusPart = min(amountMicros, 赠送还剩)
```

这套公式原来就在 `mcp.ts` 的 `budgetOf` 里跑着，现在挪进 `Meter.budget()`，数据源从
`connector_calls` 换成 `usage_charges`——于是它算的才是**三条路的总花费**。

### 6.2 熔断

**规则：`可用余额 ≤ 0` 时，这家公司所有需计费的调用一律拒绝。**

| 路 | 拒绝方式 | 为什么 |
|---|---|---|
| `/v1/chat/completions` `/v1/responses` `/v1/messages` | **HTTP 402**，body 里一句中文 | Bot 侧 `llm/gateway.ts` 会把非 2xx 的 `error` 原样变成一条失败消息给用户看 |
| `/mcp/connectors/*` | `tools/call` 返回一句人话，不是错误 | 已有行为，模型会照实转述；回错误的话模型会重试三次再放弃 |
| `/runtime/web/*` | `WebToolError` → `{ ok: false, error }` | 已有行为，同上 |

不熔断的：

- `GET /v1/models`、`tools/list`、授权流程、平台自检（`probe` / `web/test`）——
  它们不产生上游成本，本来也不记账。
- owner 自己的调用（`companyId = null`）：没有公司余额可扣。
- **这一类当前单价是 0 的调用**（`Meter.gate` 里的 `chargeable`）。拦住一个一分钱都
  不产生的调用保护不了任何人，而它会把「平台还没给某一类定价」变成「所有公司一上来
  就用不了」。模型那条的判据是「这个模型查不查得到单价」——查不到时收的本来就是 0
  （记 `unpriced`），拦它等于按「不知道」收费。

**被拒的也落一行**（`status: 'denied'`，金额 0）。「为什么我的 Bot 停了」这个问题得有
一个地方答得了，而它和「谁调了」应当在同一张表上——分两个地方查的东西，最后总有一个
没人看。

**熔断是「余额 ≤ 0 时拒绝下一次」，不是预扣。** 模型调用要跑完才知道多少钱，
预扣就得先冻一笔再补差价，那是完全另一套账。代价是最后一次调用可以透支——
上限是一次调用的量，和 `connectors.md` 已经认下的「一轮并发的透支」同量级。

### 6.3 灰度开关

```jsonc
"billing": {
  "enforce": true,        // false = 只记账不拦截（影子计费）
  "graceMicros": 0        // 允许透支多少。给「刚到期还没来得及续」留一口气
}
```

**默认 `enforce: true`。** 这条是拍板定的，和下面这个后果一起：

> **从来没下过单的公司，余额天然是 0，开闸那一刻所有调用当场哑掉。** 它们此前一直能用，
> 而这不是欠费——是我们还没开始向它们收钱。

留了两个口子接住它，两个都不改默认值、由平台按需要动：

- `graceMicros`：允许透支多少，默认 0。想给全平台留一口气就把它调大。
- 上线那几步（§11）里，回填和开闸是分开的：升级、回填完之后先把 `enforce` 关掉跑一个
  账期，对完账再打开。**默认值是开，不代表要在没对过账的时候开**——那是两件事。

真到了要收钱那天，正确的动作是给每家公司开一笔订单或充值，不是把闸关掉。

---

## 7. 三条路怎么接

### 7.1 模型（`v1.ts`）

```
requireUser → gate（402）→ recordLlmCall（拿 callId）→ 打上游
  → updateLlmCallTokens（四项 token）→ quote + charge（refId = callId）
```

四条路由（`chat/completions` 流式与非流式、`responses`、`messages`）现在都是
`if (usage) await db.updateLlmCallTokens(callId, usage)` 收尾，落账贴在同一处即可。

三件要钉住的事：

- **上游没报 usage 也要落账**：记一行 `amountMicros = 0` 且 `unpriced = true`。
  静默不落账的话，「这次调用去哪了」在账本上查不到，而 `llm_calls` 里有一行 token 全 0。

  > `unpriced` 这一格因此有**两种**含义，都读作「金额算不出来」：目录里查不到单价，
  > 和查得到单价但没拿到用量。统计屏要把它们分开报（§9），分界是**行上那份单价快照
  > 空不空**——查不到单价时 `quote` 存的是 `'{}'`，查得到时存的是四项齐全的快照，
  > 哪怕金额被按 0 记。所以任何一条落 0 元行的路都得照常把 `cost` 查出来传进
  > `settle`（清扫那条也一样，见 `routines.ts` 的 `sweepUnsettledLlmCalls`）——省掉这一
  > 步的代价不是收错钱，是把有价的模型报成「目录里没有单价」。
- **断流照落账**：`proxyUpstream` 已经保证中途断开时保留已累计的 usage
  （`proxyUpstream` 里「断流是断流，账还是要记」那条注释），落账跟着它走。
- **客户端提前断开也落账**：`streamChatCompletions` 已经写明「已经问上游要过的 token
  是花掉了的，不记账等于白送」。

### 7.2 连接器（`routes/mcp.ts`）

`budgetOf` 和 `priceMicrosOf` 删掉，换成 `meter.gate` 和 `meter.quote`。
`record()` 里除了写 `connector_calls`，再写一行账本。判定逻辑（2xx 收钱 / 超时收钱 /
自己拒掉不收钱）一个字不改——那是 `connectors.md §8` 论证过的，跟这次重构无关。

### 7.3 网页工具（`web-service.ts`）

`meter()` 换成适配器。多两件事：

- **加熔断闸**。现在只有 `dailyLimit` 次数闸，没有余额闸。位置和 `checkQuota` 并排，
  在 `runSearch` / `runExtract` 开头。
- `quoteMils` 保留（它是纯函数，好测），但返回微元；`mils` 那一列只写给旧表看。
- 命中缓存不计费、失败不计费、`document` 单列一档——全部不变（`web-tools.md §4`）。

---

## 8. 余额算得快

熔断判定在热路径上，而 `sum(amountMicros)` 是全表扫。三层：

1. **基线和花费一起缓存**：`Meter.budget()` 把「发了多少」和「花了多少」算成一个
   `Budget` 存下来。前者只有平台管理员动手时才变，后者每次调用都在动——所以缓存的是
   结果，失效靠下面第 3 条。
2. **日汇总**（`usage_daily (companyId, kind, day, …)`）：花费 = 汇总（昨天以前）+
   原始行（今天）。**这一版没做**，但账本的列现在就按能卷来设计（同 `connectors.md §9`）。
   触发它的阈值和那边一样：单表过千万行。
3. **短 TTL 记忆**：整个 budget 结果按公司缓存 1 秒，**并且落账时就地扣减**
   （`Meter.charge`）。只靠 TTL 的话，1 秒内的连续调用会一直读到同一个「还有余额」，
   透支上限变成「1 秒内能烧多少」；扣减之后只差别的进程写的那部分。
   平台改套餐、充值时显式 `meter.forget(companyId)`——不然刚付完钱的公司还要被拦一会儿，
   而那一会儿正是有人盯着屏幕等它恢复的时候。

**不建余额行。** 理由 `connectors.md §8` 已经写死：一家公司所有席位挤在同一行上排队，
为一次几十毫秒的调用付出一次行锁。

---

## 9. 接口

单次计费历史，三个范围，沿用会话索引那套游标分页（`routes/sessions.ts` 里
`GET /orgs/:id/sessions` 的写法：
`limit` + `cursor`（`${createdAt}:${id}`）+ `hasMore` + `nextCursor`）。

| 接口 | 谁 | 看什么 |
|---|---|---|
| `GET /platform/charges` | owner | 全平台。筛 `companyId` / `accountId` / `kind` / `status` / `from` / `to` |
| `GET /orgs/:id/charges` | admin | 本公司。筛 `accountId` / `botId` / `kind` |
| `GET /me/charges` | 员工 | 自己的 |
**没有单独的详情接口。** 每一行本来就带着 `quantity` 和 `unitPrice` 两个小对象，
「计量 × 单价 × 倍率 = 金额」在列表里就摊得开；再开一条接口只多给 `refId` 那边的
耗时和后端，不值得为它多一次往返和一套权限。

**「计量」那一列分两副面孔。** 平台（owner）那一侧画「输入 150 × $1.40」「倍率 ×1.2」——
这一列存在的意义就是让人自己乘一遍对得上金额。公司那一侧（管理员、员工）只画消耗：
`输入 150`、`1 次`、`4 条`。单价和倍率是平台怎么定价的，摊在客户面前等于把成本价一起
交出去了。金额那一列两边都画——那是真扣掉的钱。这一刀切在界面上（`chargeQuantity` 的
`withPrice`），接口仍然返回 `unitPrice` / `multiplier`；真要按角色裁字段，得在
`publicCharge` 那一层做。

**这里必须是接口分页，不是前端切页。** 平台那四张长表是前端切的（commit `06b4349`），
理由是「问题不在拉不动，在一屏塞不下」。账本不一样：一家公司一天就能产生几千行，
一次拉齐是真的拉不动。

改口径的既有接口：

- `GET /platform/stats`：模型金额从账本 `sum`，不再按当前单价现折。网页和连接器那两块
  合并进同一个口径。多三个提示口径，**必须分开报**：
  - `unpricedModels` / `unpricedCalls`：目录和覆盖里都查不到单价。去配置页能补。
  - `unmeteredModels` / `unmeteredCalls`：**单价是有的**，缺的是那几次调用的用量
    （上游的流一个 usage 字段都没回，或者管家没回来结算、被清扫按 0 元收了口）。
    补不回来，而且配置页没毛病——这一条一度和上一条共用 `unpriced` 一格，于是配着价
    的模型也被界面一口咬定「目录里没有单价」。两者在库里按单价快照空不空区分
    （`db.ts` 的 `chargeUsageBy`）。
  - `unledgeredModels` / `unledgeredCalls`：账本上**根本没有对应行**（`llm_calls` 左连
    `usage_charges` 数出来的）。多半是账本上线之前那段，补不回来。混成一句话的话，
    owner 会跑去模型配置页找一个并不存在的问题。

  没有第二个口径的话，翻升级前的月份看到的是真实的 token 配一个 $0.00 加零句提示——
  正是这套代码一直在防的「$0.00 被读成免费」。

  金额还分两层报，**两层数字不一样是故意的**：
  - `totals.amountMicros` / `costMicros`：只有模型那一条。按公司、按模型两张表用它。
  - `money.{llm,connector,web,all}`：三条路各自的钱和它们的和，直接按 `usage_charges.kind`
    分堆。屏幕最上面那两张金额卡报的是 `money.all`——月底从余额里扣掉的是这个和，
    只报模型那一份的话，卡上的数比账单小，而少掉的那截在这一屏上找不出来。
    卡底下那行「模型 … · 网页 … · 连接器 …」就是这个拆分，它同时解释了卡和下面
    几张表为什么对不上（每张表只管自己那一条路）。
  - `connector.byConnector` / `connector.totals`：连接器那一块，和 `web` 同形。
    库里是按 (连接器, 连接名) 分的，这里把连接名合并掉——平台视角看的是哪个连接器
    花了钱，谁用的哪一把连接在连接器页和计费明细里。
- `GET /orgs/:id/usage` / `GET /me/stats`：`daily` / `byAgent` / `byModel` 三块以前是写死的
  空数组（界面上四块永远写着「还没有用量」，而同一屏底下的计费明细一屏都是），现在都从
  已有的两张表来：次数和 token 在 `llm_calls`，钱在账本。另外多一块 `byKind`（模型 /
  连接器 / 网页），它是**盖得全**的那一维——钱就是从这三处出去的。
  - `daily` 按**看的人所在时区**切天，偏移由前端用 `tz`（分钟）传上来，同 `from` / `to`
    的道理。窗口里没有调用的那天也给一根 0 柱，否则横轴被悄悄压缩。
  - `byAgent` 只覆盖填得上 `botId` 的调用（今天只有连接器那条路）：`/v1/*` 收到的是一个
    OpenAI 兼容请求，里面没有会话这个概念（见 `lib/meter.ts`）。填不上的**不兜成「未标记」**
    ——那一行会一口气占掉九成，把真正带标识的几行压成看不见的细线。
  - `quota` 仍然是空的：当前套餐只约束席位，编一个分母出来会被当成真的在生效。
- `GET /orgs/:id/billing`：`balance` 里那几个写死的 `—` 换成真数——多出
  `planBonusLeft` / `topupLeft` / `left` / `leftMicros` / `spentThisPeriod` /
  `grantedMicros` / `enforce`。**「本期」= 当前套餐账期，不是自然月**：赠送额度按账期
  作废，跟着它数才和「还剩多少」对得上。`alertAt` 仍是 `—`（没有设置项）。
- `GET /orgs/:id/usage` 和 `GET /me/stats`：顶部「费用」卡从 `—` 变成真数；
  按成员那张表多一项 `amount`（**从账本按人汇总，不按 token 折**——一个人跑一天搜索、
  一次模型都不调，按 token 看他是零，而他确实花了钱）。

---

## 10. 界面

| 屏 | 改了什么 |
|---|---|
| 平台 · 模型配置 | 单价从两个数变成四个（缓存那截画第二行）；**回落来的价画成虚下划线 + 悬浮说明**；每行一颗「改价」写 `modelPricing` 覆盖 |
| 平台 · 自定义供应商 · 加模型 | 补 `cacheRead` / `cacheWrite` 两个输入框，留空即回落 |
| 平台 · 用量统计 | 「成本价 / 报价」改成「原价 / 已扣」；多一张缓存命中率卡；输入那格里带出缓存读写两截；底下挂一张「计费明细」，接 `/platform/charges` |
| 平台 · 公司详情 | 额度卡的大字从「发了多少」换成「还剩多少」，多一格「本期已扣」；见底时就地告警；底下挂这家公司的计费明细 |
| 公司 · 账单 | 第三个 tab「用量明细」；余额卡报剩余额而不是发放额；`本月已用` → `本期已扣`（真数）；余额 < 10% 提醒、≤ 0 告警（措辞跟着 `enforce` 变） |
| 公司 · 用量 | 顶部「费用」卡从 `—` 变成真数；成员表里永远是 `—` 的「失败率」换成「金额」 |
| 我 · 用量 | 同上，外加自己的计费明细 |

**没做**：余额预警线还没有设置项，账单屏上那一格仍是 `—`——不编一个会被当成真在生效的阈值。

---

## 11. 迁移与上线顺序

迁移一条一件事（`db/migrations/index.ts` 里那两条规矩）：

- `0007-usage-charges` — 建账本表和索引
- `0008-llm-cache-write` — `llm_calls` 加 `cacheWriteTokens`
- `0009-multiplier-precision` — 账本的 `multiplier` 从 `real` 换成 `double precision`

最后那条是给 0007 打的补丁：float4 存不下 `1.2`（写进去读回来是 `1.2000000476837158`，
会原样画到计费明细上，「原价 = 成交额 ÷ 倍率」那个除法也带着这个误差）。**没有回去改
0007**——已经跑过的迁移不能改，校验和是对那段 SQL 算的，往里加一行注释都会让下次起
进程被 `migrate.ts` 拦下来。老行里那个不精确的值转类型也补不回来（精度在写入时就没了），
所以界面上仍然收一下小数位。

**迁移没有 down 脚本。** 每条只有向前的 SQL，「撤销」是再写一条新的把它改回去
（`gateway/README.md` 的规矩）；真要回到升级前的状态，靠的是升级前的库快照，
不是反向迁移——所以上线顺序第一步之前先备份。

**回填不进迁移。** 那是一次性数据订正（同一条规矩的下半句），走
`gateway/scripts/backfill-charges.mjs`：把 `connector_calls` 和 `web_calls` 的历史
翻成账本行（`web_calls.mils × 1000`），金额**原样搬**，不按今天的单价重算。
历史模型调用一行都不写，只在末尾报一个条数——见本节末尾那段。

**代码里是终态**：账本是唯一的钱，`connector_calls.amountMicros` / `bonusMicros` /
`web_calls.mils` 新行恒为 0，统计按 `refId` 从账本取金额。没有做「双写一段时间再切」——
两份金额并存的那段时间里，对不上的时候没人说得清该信哪一份。

代价是**回填必须跟着这次升级一起做**，顺序钉死：

1. 停服，升级，**起一次进程**（迁移 0007 / 0008 在启动时自己跑掉，日志里会打出
   「已应用 N 条迁移」）。顺序反过来最容易发生，所以脚本会先自检一遍库升到位没有，
   没有就报一句人话并退出，不去撞那张还不存在的表。
2. `node gateway/scripts/backfill-charges.mjs --dry-run` 看一眼条数对不对。
3. **立刻**去掉 `--dry-run` 再跑一次。不跑的话，各家公司此前在连接器和网页工具上花掉
   的钱在账本上不存在，余额看着比实际多。断了直接重跑——按 `refId` 跳过已有的行。
4. 对完一个账期再谈开闸——`enforce` 默认是开的，但**默认值是开不等于要在没对过账
   的时候开**。对账期间可以先把它关掉（§6.3）。

**历史模型调用一行都不回填。** 那时候没有「收了多少」这件事；按今天的单价折出来的
数字是「今天会收多少」，写进账本等于凭空给每家公司记上一笔从来没发生过的欠账。
脚本只把这些调用的条数打出来，让人知道账本上有这么一段是空的。

这条规矩**回填脚本之外也管**：管家中继的未结算清扫（`routines.ts` 的
`sweepUnsettledLlmCalls`）同样不许碰历史行。它扫的是「授权了没回来结算」的调用，而
`llm_calls` 从 0001 就有、账本的 `refId` 0007 才加，判据里只要不写死「中继真的授权过」
（`llm_calls.relayMachineId` 非空，迁移 0040），0007 之前的每一行都会被当成漏结算的，
每拍补 200 笔假账。补出来的不只是欠账：`unledgeredCalls`（管理台那条「这一段账是空的」
横幅）会被抹成 0，而账本行盖的是**记账当下**的时间戳，几年前的调用会集体涌进本月账单。

---

## 12. 验收

`e2e/billing.mjs`（18 条，走真实路径：假上游 + 真 `/v1/messages` + 真
`/runtime/web/search`）：

1. **缓存计价**：上游报 `cache_read_input_tokens` / `cache_creation_input_tokens`，
   账本金额等于手算的四段和（$3.40）——整个提示词按输入价算会得到 $11.40。
2. **单价钉死在覆盖表上**，不吃 pi-ai 内置目录：目录价随上游调价和依赖升级而动，
   写进断言就是一颗定时炸弹。顺带把覆盖表本身验了。
3. **`llm_calls` 记下缓存写那一截**。
4. **扣费顺序**：赠送 $2 + 充值 $50，一笔 $3.40 里 `bonusMicros` 正好 $2。
5. **改倍率不追溯**：历史行金额不变，新的一次按新倍率收，倍率落在行上。
6. **熔断**：余额见底时先放行一次（不预扣），下一次 402 并落一行 `denied`。
7. **熔断是全局的、按公司的**：同一家的网页搜索一起停，别家不受影响。
8. **充值当场恢复**，不用等余额缓存过期。
9. **单价为 0 的调用不熔断**。
10. **影子计费**：`enforce: false` 时照记不拦。
11. **分页**不重不漏，公司只看得见自己家，员工只看得见自己的。
12. 平台明细跨公司可见，无票 401、公司管理员 403。
13. 按 `kind` 筛选；坏 `kind` 400。
14. **回填脚本**：造两条「老行」（钱还在领域表自己的列上、账本上没有对应行），
    真的 spawn 一次 `backfill-charges.mjs`，验金额原样搬过来、厘 ×1000 换成微元、
    再跑一遍不翻倍。这段代码只会跑一次、而且是对着生产库跑的，没有别的机会验它。
15. **回填脚本的错误界面**：撞上没升级的库、连不上库时给一句人话和退出码 1，
    不甩 pg 的堆栈，也不把连接串里的口令回显出来。
16. **只填一项的单价覆盖**：其余几项从 `/v1/models` 拿到的目录价来，不会被清零，
    金额 > 0 且 `unpriced` 为 false。
17. **倍率 1.2 存进去读回来还是 1.2**（迁移 0009 之前是 1.2000000476837158；
    早先那条用的是倍率 2，float4 里恰好精确，测不出来）。
18. **提取的余额闸看 `document` 那一档**：提取后端定价 0、`document` 定价非 0 时，
    余额见底的公司抓 PDF 也要被拦下来。

`e2e/stats.mjs` 多一条：账本上没有对应行的调用要进 `unledgeredModels` 且不被误报成
「没单价」。`e2e/ui-smoke.mjs` 多两条：明细和汇总永远问同一个时间窗（`/stats` 跟统计
胶囊、`/usage` 跟自己的范围胶囊、账单页是全时段）；倍率对所有计费种类都画出来，不只
是模型——这一列的意义就是让人自己乘一遍对得上金额。

跟着改口径的既有用例：`e2e/stats.mjs`（金额从账本汇总，缓存那两截只验汇总不验计价）、
`e2e/web-tools.mjs`（金额断言从 `web_calls.mils` 挪到账本的微元），
`e2e/org.mjs` 的 `createCompany` 默认充一笔——余额熔断默认开着，没有余额的公司
连搜索都发不出去，这一点生产上也一样；要验「没下过单的公司长什么样」就传 `topup: 0`
（`e2e/run.mjs` 的账单那条和 `e2e/machine-deploy.mjs` 那条真删公司的用例就是这么做的）。
`e2e/ui-smoke.mjs` 的账单夹具换成新形状，并多一条「告警措辞跟着 `enforce` 变」。

---

## 13. 三件已经拍板的事

1. **`enforce` 默认打开。** 后果和两个缓冲口子见 §6.3：从没下过单的公司会被挡在门外，
   要么给它开单，要么调 `graceMicros`，要么在对账期间临时关掉。
2. **缺的缓存单价按 `input` 兜底**——回落链是**逐字段**的「覆盖 → 目录 → 平台兜底 →
   `input`」，而 `input` / `output` **缺任意一侧就算不计价**（见 §3.3 里那两段踩过的坑）。
   代价是缓存读会按输入价高估，界面上把回落来的价画成另一种样子。
3. **`connector_calls` / `web_calls` 的金额列停写，改由账本承担。** 要跑一次回填脚本，
   是这套方案里唯一动到已有数据的地方。
