/**
 * 用量与钱：模型 / 网页调用流水、连接器（安装、连接、调用流水）、计费账本。
 *
 * 事实在各自的流水表里，钱只在账本（usage_charges）里，汇总时按 refId 接起来
 * （见 sql.ts 的 LEDGER_BY_REF）。
 */
import { randomUUID } from 'node:crypto'
import { bucketSql, DAY_MS, filterSql, LEDGER_BY_REF } from './sql.ts'
import { CHARGE_PAGE_DEFAULT, CHARGE_PAGE_MAX, type ChargeKind, type ChargeStatus, type CompanyModelUsage, type ConnectionScope, type ConnectionStatus, type ConnectorCall, type ConnectorCallStatus, type ConnectorConnection, type ConnectorInstall, type LlmCall, type LlmUsage, type UsageCharge, type WebCall, type WebCallKind } from './types.ts'
import { connectorConnectionOf, connectorInstallOf, isUniqueViolation, llmCallOf, num, numOrNull, str, strOrNull, usageChargeOf } from './rows.ts'
import { OrgDb } from './org.ts'

/**
 * 明细与重算共用的筛选。companyId 为 null 的是 owner 自己的调用：传了 companyId 就只看这一家，
 * 不传就是全平台（含平台自己那些）。
 */
function chargeFilterSql(filter: {
  companyId?: string
  accountId?: string
  botId?: string
  kind?: ChargeKind
  status?: ChargeStatus
  from?: number
  to?: number
}): { sql: string; args: unknown[] } {
  return filterSql(
    [['"companyId"', filter.companyId], ['"accountId"', filter.accountId], ['"botId"', filter.botId], ['kind', filter.kind], ['status', filter.status]],
    filter,
  )
}

export class UsageDb extends OrgDb {
  /**
   * 登记一次模型调用。
   *
   * `relayMachineId`（迁移 0040）是**清扫的判据，不是业务字段**，所以它只进库、不进
   * 返回的 LlmCall：非空表示「这一行是中继授权出去的」，未结算清扫只认这一撮
   * （见 unsettledLlmCalls）。/v1 自己代理的那几条不传——它们有 withSettle 兜着收口，
   * 本来就不该被事后扫。
   */
  async insertLlmCall(input: {
    accountId: string
    companyId?: string | null
    provider: string
    model: string
    promptTokens?: number
    completionTokens?: number
    cachedTokens?: number
    cacheWriteTokens?: number
    relayMachineId?: string | null
  }): Promise<LlmCall> {
    const row: LlmCall = {
      id: randomUUID(),
      accountId: input.accountId,
      companyId: input.companyId ?? null,
      provider: input.provider,
      model: input.model,
      promptTokens: input.promptTokens ?? 0,
      completionTokens: input.completionTokens ?? 0,
      cachedTokens: input.cachedTokens ?? 0,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      createdAt: Date.now(),
    }
    await this.run(
      'insert into llm_calls (id, "accountId", "companyId", provider, model, "promptTokens", "completionTokens", "cachedTokens", "cacheWriteTokens", "createdAt", "relayMachineId") values (?,?,?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.accountId,
        row.companyId,
        row.provider,
        row.model,
        row.promptTokens,
        row.completionTokens,
        row.cachedTokens,
        row.cacheWriteTokens,
        row.createdAt,
        input.relayMachineId ?? null,
      ],
    )
    return row
  }

  async updateLlmCallTokens(
    id: string,
    usage: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number; cache_write_tokens?: number },
  ): Promise<void> {
    await this.run(
      'update llm_calls set "promptTokens"=?, "completionTokens"=?, "cachedTokens"=?, "cacheWriteTokens"=? where id=?',
      [usage.prompt_tokens, usage.completion_tokens, usage.cached_tokens ?? 0, usage.cache_write_tokens ?? 0, id],
    )
  }

  /**
   * 这颗模型最近成功调用的用量，新的在前。生图预估的实测基线用（lib/image-estimate.ts）。
   *
   * 只要**真成交过**的：账本上那一行是 `ok`、而且真有输出。被拒的、失败的、清扫收口的
   * 占位行都是 0 token，混进来会把基线往下拽——而基线偏低就是闸门放过透支。
   */
  async recentModelUsage(provider: string, model: string, since: number, limit: number): Promise<{ promptTokens: number; completionTokens: number }[]> {
    const rows = await this.many(
      `select c."promptTokens", c."completionTokens" from llm_calls c
         join usage_charges u on u."refId" = c.id and u.kind = 'llm' and u.status = 'ok'
        where c.provider = ? and c.model = ? and c."createdAt" >= ? and c."completionTokens" > 0
        order by c."createdAt" desc limit ?`,
      [provider, model, since, limit],
    )
    return rows.map((r) => ({ promptTokens: Number(r.promptTokens) || 0, completionTokens: Number(r.completionTokens) || 0 }))
  }

  async llmCall(id: string): Promise<LlmCall | undefined> {
    const r = await this.one('select * from llm_calls where id = ?', [id])
    return r ? llmCallOf(r) : undefined
  }

  /**
   * 同一账号、同一模型、`since` 之后、`before` 之前**最近一次真结算过**的调用用量。
   * 没拿到 usage 的那次要靠它估（lib/llm-billing.ts 的 estimateUsage）。
   *
   * 只认账本上 `ok`、不是估的、而且真有输入的那行：估的推估的会把误差滚起来，0 token
   * 的占位行推出来的还是 0。`before` 是这次调用自己登记的时刻——比它晚的调用是别的轮次，
   * 不是「上一次」。
   */
  async lastSettledLlmCall(
    accountId: string,
    provider: string,
    model: string,
    range: { since: number; before: number },
  ): Promise<{ promptTokens: number; completionTokens: number; cachedTokens: number; createdAt: number } | undefined> {
    const r = await this.one(
      `select c."promptTokens", c."completionTokens", c."cachedTokens", c."createdAt" from llm_calls c
         join usage_charges u on u."refId" = c.id and u.kind = 'llm' and u.status = 'ok' and u.estimated = false
        where c."accountId" = ? and c.provider = ? and c.model = ? and c."createdAt" >= ? and c."createdAt" < ? and c."promptTokens" > 0
        order by c."createdAt" desc limit 1`,
      [accountId, provider, model, range.since, range.before],
    )
    if (!r) return undefined
    return {
      promptTokens: Number(r.promptTokens) || 0,
      completionTokens: Number(r.completionTokens) || 0,
      cachedTokens: Number(r.cachedTokens) || 0,
      createdAt: Number(r.createdAt) || 0,
    }
  }

  /**
   * 这一次调用落过账没有。管家中继的结算接口靠它做幂等：管家重试、或者清扫和结算
   * 撞在一起时，第二笔只能是「已经记过了」，不能再挂一行。
   */
  async chargeExistsForRef(refId: string): Promise<boolean> {
    const r = await this.one('select 1 as n from usage_charges where "refId" = ? limit 1', [refId])
    return !!r
  }

  /**
   * `before` 之前登记、账本上却没有对应行、**而且确实是中继授权出去的**调用——管家拿了
   * 授权（grant）之后死在半路，没来得及结算的那些。清扫拿它们按 failed 收口
   * （routines.ts 的 sweepUnsettledLlmCalls）。
   *
   * **`relayMachineId is not null` 这一条不能少。** 少了它，判据就只剩「够老 + 账本上没
   * 对应行」，而 `llm_calls` 从 0001 就有、账本（`usage_charges.refId`）0007 才加——
   * 于是 0007 之前的每一行都命中，`order by createdAt asc` 又是从最老的开始捞，清扫会
   * 每拍给 200 条历史调用补一笔 failed / 0 元的假账。这有三处后果：docs/billing.md §11
   * 说死了「历史模型调用一行都不回填」；`llmUsageByCompanyModel` 的 `unledgeredCalls`
   * （管理台那条「这一段账是空的」横幅靠它）会被抹成 0；`insertUsageCharge` 盖的是当下
   * 的时间戳，几年前的调用会集体涌进本月账单页。历史行这一格全是 null，扫不到。
   */
  async unsettledLlmCalls(before: number, limit: number): Promise<LlmCall[]> {
    // not exists 走 usage_ref 那条索引；按 refId 把整张账本先聚合一遍（LEDGER_BY_REF）在
    // 这里太重——这条每半分钟跑一次。非空那一撮另有部分索引 llm_calls_unsettled（0040）。
    const rows = await this.many(
      `select l.* from llm_calls l
       where l."createdAt" < ? and l."relayMachineId" is not null
         and not exists (select 1 from usage_charges u where u."refId" = l.id)
       order by l."createdAt" asc limit ?`,
      [before, limit],
    )
    return rows.map(llmCallOf)
  }

  async insertWebCall(input: {
    accountId: string
    companyId?: string | null
    kind: WebCallKind
    backend: string
    units: number
  }): Promise<WebCall> {
    const row: WebCall = {
      id: randomUUID(),
      accountId: input.accountId,
      companyId: input.companyId ?? null,
      kind: input.kind,
      backend: input.backend,
      units: input.units,
      // 同 connector_calls：钱在账本里，这一列留给老行，新行恒为 0。
      mils: 0,
      createdAt: Date.now(),
    }
    await this.run(
      'insert into web_calls (id, "accountId", "companyId", kind, backend, units, mils, "createdAt") values (?,?,?,?,?,?,?,?)',
      [row.id, row.accountId, row.companyId, row.kind, row.backend, row.units, row.mils, row.createdAt],
    )
    return row
  }

  /** 按公司 × 后端 × 类型汇总。金额直接求和——它已经是当时的报价，不重算。 */
  async webUsageByCompanyBackend(
    range?: { from?: number; to?: number },
    companyId?: string,
  ): Promise<{ companyId: string | null; backend: string; kind: string; calls: number; units: number; amountMicros: number; lastAt: number | null }[]> {
    const r = this.llmRangeSql(range)
    const args: unknown[] = [...r.args]
    let where = `where 1=1${r.sql}`
    if (companyId) {
      where += ' and "companyId" = ?'
      args.push(companyId)
    }
    // 金额按 refId 从账本接回来。web_calls 有 backend / kind / units 这些账本里没有的
    // 维度，账本有钱——两边各出各的那一半（docs/billing.md §2）。老行的钱还在 mils 上，
    // 回填脚本会把它们翻成账本行，所以这里只认账本，不再 `sum(mils)`。
    const rows = await this.many(
      `select w."companyId", w.backend, w.kind, count(*) as calls,
              coalesce(sum(w.units), 0) as units,
              coalesce(sum(u.micros), 0) as micros,
              max(w."createdAt") as "lastAt"
       from web_calls w left join ${LEDGER_BY_REF} u on u."refId" = w.id
       ${where.replace(/"companyId"/g, 'w."companyId"').replace(/"createdAt"/g, 'w."createdAt"')}
       group by w."companyId", w.backend, w.kind`,
      args,
    )
    return rows.map((row) => ({
      companyId: strOrNull(row.companyId),
      backend: str(row.backend),
      kind: str(row.kind),
      calls: num(row.calls),
      units: num(row.units),
      amountMicros: num(row.micros),
      lastAt: row.lastAt == null ? null : num(row.lastAt),
    }))
  }

  /** 这家公司从某个时刻起用了多少次。配额闸用它，所以只数条数不取行。 */
  async webCallCountSince(companyId: string, since: number): Promise<number> {
    const r = await this.one('select count(*)::int as n from web_calls where "companyId" = ? and "createdAt" >= ?', [
      companyId,
      since,
    ])
    return num(r?.n ?? 0)
  }

  private llmRangeSql(range?: { from?: number; to?: number }): { sql: string; args: (string | number)[] } {
    return filterSql([], range)
  }

  private async llmUsageBy(
    column: 'companyId' | 'accountId',
    value: string,
    range?: { from?: number; to?: number },
  ): Promise<LlmUsage> {
    const r = this.llmRangeSql(range)
    const total = await this.one(
      `select count(*) as calls, coalesce(sum("promptTokens"), 0) as "promptTokens", coalesce(sum("completionTokens"), 0) as "completionTokens" from llm_calls where "${column}" = ?${r.sql}`,
      [value, ...r.args],
    )
    const by = await this.many(
      `select "accountId", count(*) as calls, coalesce(sum("promptTokens"), 0) as "promptTokens", coalesce(sum("completionTokens"), 0) as "completionTokens", max("createdAt") as "lastAt" from llm_calls where "${column}" = ?${r.sql} group by "accountId"`,
      [value, ...r.args],
    )
    return {
      calls: num(total?.calls ?? 0),
      promptTokens: num(total?.promptTokens ?? 0),
      completionTokens: num(total?.completionTokens ?? 0),
      byAccount: by.map((row) => ({
        accountId: str(row.accountId),
        calls: num(row.calls),
        promptTokens: num(row.promptTokens),
        completionTokens: num(row.completionTokens),
        lastAt: numOrNull(row.lastAt),
      })),
    }
  }

  /**
   * 每日调用数，给用量屏那根日线。
   *
   * **按看的人所在时区切天。** 服务端不知道那是哪个时区（同 `/platform/stats` 的窗口
   * 一样由前端算好传上来），所以切桶之前先把时间平移 `offsetMs`——不平移的话，东八区
   * 早上八点之前的调用会落进前一天，整条日线左移一格，而这种错在图上看不出来。
   *
   * 返回的是桶号（平移之后的天序号），不是日期字符串：日期怎么写是显示的事，
   * 而且 SQL 里格式化日期还得再引入一次时区。
   */
  async llmDailyBy(
    column: 'companyId' | 'accountId',
    value: string,
    range?: { from?: number; to?: number },
    offsetMs = 0,
    bucketMs = DAY_MS,
  ): Promise<{ bucket: number; calls: number }[]> {
    return this.llmDaily({ column, value }, range, offsetMs, bucketMs)
  }

  /**
   * 平台视角的每日调用数：全部公司一起数，或者只数某一家。owner 自己那些
   * `companyId` 为空的调用也在里面——统计页的合计就是这么算的，日线不能少它一截。
   */
  llmDailyAll(range?: { from?: number; to?: number }, offsetMs = 0, companyId?: string, bucketMs = DAY_MS): Promise<{ bucket: number; calls: number }[]> {
    return this.llmDaily(companyId ? { column: 'companyId', value: companyId } : null, range, offsetMs, bucketMs)
  }

  private async llmDaily(
    scope: { column: 'companyId' | 'accountId'; value: string } | null,
    range?: { from?: number; to?: number },
    offsetMs = 0,
    bucketMs = DAY_MS,
  ): Promise<{ bucket: number; calls: number }[]> {
    const r = this.llmRangeSql(range)
    const w = this.dailyScopeSql(scope)
    const rows = await this.many(
      `select floor(("createdAt" + ?) / ${bucketSql(bucketMs)})::bigint as bucket, count(*) as calls
       from llm_calls where ${w.sql}${r.sql}
       group by bucket order by bucket`,
      [offsetMs, ...w.args, ...r.args],
    )
    return rows.map((row) => ({ bucket: num(row.bucket), calls: num(row.calls) }))
  }

  /**
   * 每日扣了多少钱，给日线每根柱子标金额。切天的规矩和 `llmDailyBy` 一样（按看的人所在
   * 时区平移），两边桶号才对得上。钱走账本，三条计费路（模型 / 连接器 / 网页）都算——
   * 柱高是模型调用次数，金额是那一天一共花出去的。
   */
  async chargeDailyBy(
    column: 'companyId' | 'accountId',
    value: string,
    range?: { from?: number; to?: number },
    offsetMs = 0,
    bucketMs = DAY_MS,
  ): Promise<{ bucket: number; amountMicros: number }[]> {
    return this.chargeDaily({ column, value }, range, offsetMs, bucketMs)
  }

  /** 平台视角的每日扣费，和 `llmDailyAll` 配对：全部公司一起算，或者只算某一家。 */
  chargeDailyAll(range?: { from?: number; to?: number }, offsetMs = 0, companyId?: string, bucketMs = DAY_MS): Promise<{ bucket: number; amountMicros: number }[]> {
    return this.chargeDaily(companyId ? { column: 'companyId', value: companyId } : null, range, offsetMs, bucketMs)
  }

  private async chargeDaily(
    scope: { column: 'companyId' | 'accountId'; value: string } | null,
    range?: { from?: number; to?: number },
    offsetMs = 0,
    bucketMs = DAY_MS,
  ): Promise<{ bucket: number; amountMicros: number }[]> {
    const r = this.llmRangeSql(range)
    const w = this.dailyScopeSql(scope)
    const rows = await this.many(
      `select floor(("createdAt" + ?) / ${bucketSql(bucketMs)})::bigint as bucket, coalesce(sum("amountMicros"), 0) as "amountMicros"
       from usage_charges where ${w.sql}${r.sql}
       group by bucket order by bucket`,
      [offsetMs, ...w.args, ...r.args],
    )
    return rows.map((row) => ({ bucket: num(row.bucket), amountMicros: num(row.amountMicros) }))
  }

  /** 日线的范围子句：按公司 / 按人，或者（平台视角）不限。列名是白名单里的两个，不是外面传进来的字符串。 */
  private dailyScopeSql(scope: { column: 'companyId' | 'accountId'; value: string } | null): { sql: string; args: string[] } {
    return scope ? { sql: `"${scope.column}" = ?`, args: [scope.value] } : { sql: '1=1', args: [] }
  }

  llmUsageOfCompany(companyId: string, range?: { from?: number; to?: number }): Promise<LlmUsage> {
    return this.llmUsageBy('companyId', companyId, range)
  }

  llmUsageOfAccount(accountId: string, range?: { from?: number; to?: number }): Promise<LlmUsage> {
    return this.llmUsageBy('accountId', accountId, range)
  }

  /**
   * 平台统计的底表：按 (公司, 供应商, 模型) 汇总。
   *
   * 折成金额要按模型单价算，所以必须细到模型这一层再聚合——只按公司汇总的话
   * 拿不回每条调用用的是哪个模型，价就算不出来。
   * companyId 为 null 的是 owner 自己的调用，原样留着，由上层标成「平台」。
   *
   * **`cachedTokens` 必须一起汇总。** 它是 `promptTokens` 的子集，而缓存读的单价
   * 低得多（Anthropic 是输入价的十分之一）。少了这一列，上层只能把整个提示词按
   * 输入价算——一个 Bot 一条长会话、系统提示词稳定，正是缓存命中率最高的形态，
   * 于是缓存命中率越高、账面越虚，而 quotedUsd 是报给公司的价。
   */
  async llmUsageByCompanyModel(
    range?: { from?: number; to?: number },
    companyId?: string,
    accountId?: string,
  ): Promise<CompanyModelUsage[]> {
    const r = this.llmRangeSql(range)
    let where = `where 1=1${r.sql}`
    const args: (number | string)[] = [...r.args]
    if (companyId) {
      where += ' and "companyId" = ?'
      args.push(companyId)
    }
    // 员工自己那一屏按人过滤：同一段聚合，只是范围小一圈。
    if (accountId) {
      where += ' and "accountId" = ?'
      args.push(accountId)
    }
    /**
     * `unledgeredCalls`：这一组里**账本上根本没有对应行**的调用数。
     *
     * 金额只从账本来之后，「按 $0 收了」和「压根没记过账」在结果里长得一模一样，
     * 而后者恰恰是升级前所有历史调用的样子（回填脚本刻意不给模型调用补金额）。
     * 不把它数出来的话，翻上个月看到的是真实的 token 配一个 $0.00 加零句提示——
     * 那正是这套代码一直在防的「$0.00 被读成免费」。
     *
     * **账本先按 refId 收成一行再 join。** `usage_charges."refId"` 上只有一条普通索引，
     * 不是唯一约束——一次崩在 insertLlmCall 和记账之间、随后重算的调用，或者一条被重放
     * 的 outbox 上报，都会让同一个 refId 上挂两行账。直接 join 的话那一行 llm_calls 会
     * 被复制一份，calls 数成 2、每一列 token 翻倍，报给公司的 quotedUsd 跟着虚高。
     */
    const rows = await this.many(
      `select l."companyId", l.provider, l.model, count(*) as calls,
              coalesce(sum(l."promptTokens"), 0) as "promptTokens",
              coalesce(sum(l."completionTokens"), 0) as "completionTokens",
              coalesce(sum(l."cachedTokens"), 0) as "cachedTokens",
              coalesce(sum(l."cacheWriteTokens"), 0) as "cacheWriteTokens",
              coalesce(sum(case when u."refId" is null then 1 else 0 end), 0) as "unledgeredCalls",
              max(l."createdAt") as "lastAt"
       from llm_calls l left join ${LEDGER_BY_REF} u on u."refId" = l.id
       ${where.replace(/"(companyId|accountId|createdAt)"/g, 'l."$1"')}
       group by l."companyId", l.provider, l.model
       order by l."companyId", l.provider, l.model`,
      args,
    )
    return rows.map((row) => ({
      companyId: strOrNull(row.companyId),
      provider: str(row.provider),
      model: str(row.model),
      calls: num(row.calls),
      promptTokens: num(row.promptTokens),
      completionTokens: num(row.completionTokens),
      cachedTokens: num(row.cachedTokens),
      cacheWriteTokens: num(row.cacheWriteTokens),
      unledgeredCalls: num(row.unledgeredCalls),
      lastAt: numOrNull(row.lastAt),
    }))
  }

  // ── 连接器：安装、连接、调用流水。见 docs/connectors.md §10。────────

  async connectorInstalls(accountId: string): Promise<ConnectorInstall[]> {
    const rows = await this.many('select * from connector_installs where "accountId" = ? order by "createdAt"', [accountId])
    return rows.map(connectorInstallOf)
  }

  /** 一家公司谁装了什么。admin 那一屏唯一能看清攻击面的地方。 */
  async connectorInstallsOfCompany(companyId: string): Promise<ConnectorInstall[]> {
    const rows = await this.many('select * from connector_installs where "companyId" = ? order by "createdAt"', [companyId])
    return rows.map(connectorInstallOf)
  }

  async connectorInstall(connectorId: string, accountId: string): Promise<ConnectorInstall | undefined> {
    const r = await this.one('select * from connector_installs where "connectorId" = ? and "accountId" = ?', [connectorId, accountId])
    return r ? connectorInstallOf(r) : undefined
  }

  /**
   * 装一个。**已经装了就原样返回**，不报错也不重置工具开关——重复点「安装」是
   * 用户会做的事（网络慢、手抖），把它变成一次静默的配置重置就太狠了。
   */
  async installConnector(input: {
    connectorId: string
    accountId: string
    companyId: string
    /**
     * 装上默认开哪几个。空 = 写 `[]`，也就是全开。
     *
     * **`[]` = 全开这个口径不动。** 已经装好的那些存的就是 `[]`，改口径等于让现存
     * 用户的工具悄悄少掉一批。改的只是「新装的时候写什么进去」（docs/tool-search.md §2）。
     */
    enabledTools?: string[]
  }): Promise<ConnectorInstall> {
    const cur = await this.connectorInstall(input.connectorId, input.accountId)
    if (cur) return cur
    const now = Date.now()
    const row: ConnectorInstall = {
      id: randomUUID(),
      connectorId: input.connectorId,
      accountId: input.accountId,
      companyId: input.companyId,
      enabledTools: input.enabledTools ?? [],
      createdAt: now,
      updatedAt: now,
    }
    try {
      await this.savepoint(() =>
        this.run(
          'insert into connector_installs (id, "connectorId", "accountId", "companyId", "enabledTools", "createdAt", "updatedAt") values (?,?,?,?,?,?,?)',
          [row.id, row.connectorId, row.accountId, row.companyId, JSON.stringify(row.enabledTools), row.createdAt, row.updatedAt],
        ),
      )
    } catch (e) {
      // 两次点击撞在一起：唯一索引兜住，取回已有的那条。
      if (!isUniqueViolation(e)) throw e
      return (await this.connectorInstall(input.connectorId, input.accountId))!
    }
    return row
  }

  async setInstallTools(id: string, enabledTools: string[]): Promise<ConnectorInstall | undefined> {
    await this.run('update connector_installs set "enabledTools" = ?, "updatedAt" = ? where id = ?', [
      JSON.stringify(enabledTools),
      Date.now(),
      id,
    ])
    const r = await this.one('select * from connector_installs where id = ?', [id])
    return r ? connectorInstallOf(r) : undefined
  }

  async deleteConnectorInstall(id: string): Promise<void> {
    await this.run('delete from connector_installs where id = ?', [id])
  }

  async connectorConnection(id: string): Promise<ConnectorConnection | undefined> {
    const r = await this.one('select * from connector_connections where id = ?', [id])
    return r ? connectorConnectionOf(r) : undefined
  }

  /**
   * 这个账号能用的所有连接：自己的，加上本公司共用的那些。
   *
   * 合成工具表、`@` 选单、计费归属都从这一条出发——「能用哪些」只有一个来源，
   * 免得三处各写一遍再慢慢分叉。
   */
  async connectionsFor(accountId: string, companyId: string | null): Promise<ConnectorConnection[]> {
    const rows = companyId
      ? await this.many(
          'select * from connector_connections where ("accountId" = ? and scope = \'user\') or ("companyId" = ? and scope = \'company\') order by "createdAt"',
          [accountId, companyId],
        )
      : await this.many('select * from connector_connections where "accountId" = ? and scope = \'user\' order by "createdAt"', [accountId])
    return rows.map(connectorConnectionOf)
  }

  async connectionsOfCompany(companyId: string): Promise<ConnectorConnection[]> {
    const rows = await this.many('select * from connector_connections where "companyId" = ? order by "createdAt"', [companyId])
    return rows.map(connectorConnectionOf)
  }

  async insertConnectorConnection(input: {
    connectorId: string
    vendor: string
    scope: ConnectionScope
    label: string
    accountId: string | null
    companyId: string
    externalUserId: string
    mentionOnly?: boolean
  }): Promise<ConnectorConnection> {
    const now = Date.now()
    const row: ConnectorConnection = {
      id: randomUUID(),
      connectorId: input.connectorId,
      vendor: input.vendor,
      scope: input.scope,
      label: input.label,
      accountId: input.accountId,
      companyId: input.companyId,
      externalUserId: input.externalUserId,
      externalId: null,
      status: 'pending',
      mentionOnly: input.mentionOnly ?? false,
      lastError: null,
      connectedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into connector_connections (id, "connectorId", vendor, scope, label, "accountId", "companyId", "externalUserId", "externalId", status, "mentionOnly", "lastError", "connectedAt", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.connectorId,
        row.vendor,
        row.scope,
        row.label,
        row.accountId,
        row.companyId,
        row.externalUserId,
        row.externalId,
        row.status,
        row.mentionOnly,
        row.lastError,
        row.connectedAt,
        row.createdAt,
        row.updatedAt,
      ],
    )
    return row
  }

  async updateConnectorConnection(
    id: string,
    patch: {
      label?: string
      externalId?: string | null
      status?: ConnectionStatus
      mentionOnly?: boolean
      lastError?: string | null
      connectedAt?: number | null
    },
  ): Promise<ConnectorConnection | undefined> {
    const cur = await this.connectorConnection(id)
    if (!cur) return undefined
    const next = { ...cur, ...patch, updatedAt: Date.now() }
    await this.run(
      'update connector_connections set label=?, "externalId"=?, status=?, "mentionOnly"=?, "lastError"=?, "connectedAt"=?, "updatedAt"=? where id=?',
      [next.label, next.externalId, next.status, next.mentionOnly, next.lastError, next.connectedAt, next.updatedAt, id],
    )
    return next
  }

  async deleteConnectorConnection(id: string): Promise<void> {
    await this.run('delete from connector_connections where id = ?', [id])
  }

  async insertConnectorCall(input: {
    companyId: string | null
    accountId: string
    connectionId?: string | null
    botId?: string | null
    sessionId?: string | null
    vendor: string
    connector: string
    label?: string
    tool: string
    status: ConnectorCallStatus
    latencyMs?: number
    viaMention?: boolean
  }): Promise<ConnectorCall> {
    const row: ConnectorCall = {
      id: randomUUID(),
      companyId: input.companyId,
      accountId: input.accountId,
      connectionId: input.connectionId ?? null,
      botId: input.botId ?? null,
      sessionId: input.sessionId ?? null,
      vendor: input.vendor,
      connector: input.connector,
      label: input.label ?? '',
      tool: input.tool,
      status: input.status,
      // 钱不在这张表里了，见 docs/billing.md §2：账本（usage_charges）是唯一的钱。
      // 这两列留着是为了老行，新行恒为 0——统计要金额时按 refId 去账本上取。
      amountMicros: 0,
      bonusMicros: 0,
      latencyMs: Math.max(0, Math.trunc(input.latencyMs ?? 0)),
      viaMention: input.viaMention ?? false,
      createdAt: Date.now(),
    }
    await this.run(
      'insert into connector_calls (id, "companyId", "accountId", "connectionId", "botId", "sessionId", vendor, connector, label, tool, status, "amountMicros", "bonusMicros", "latencyMs", "viaMention", "createdAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.companyId,
        row.accountId,
        row.connectionId,
        row.botId,
        row.sessionId,
        row.vendor,
        row.connector,
        row.label,
        row.tool,
        row.status,
        row.amountMicros,
        row.bonusMicros,
        row.latencyMs,
        row.viaMention,
        row.createdAt,
      ],
    )
    return row
  }

  /**
   * 连接器用量：一次查询给出四种切法。
   *
   * 按 (谁 / 连接器 / 工具 / 状态) 分别 group by，而不是把原始行拉回来在 JS 里算——
   * 一天几万行，拉回来就是拿内存换一句 SQL。
   *
   * 金额直接 `sum(amountMicros)`，**不按当前单价现折**：单价改过之后，历史账不能跟着
   * 一起变（docs/connectors.md §9）。
   */
  async connectorUsage(
    scope: { companyId?: string | null; accountId?: string },
    range?: { from?: number; to?: number },
  ): Promise<{
    total: { calls: number; amountMicros: number; lastAt: number | null }
    byStatus: { status: string; calls: number; amountMicros: number }[]
    byAccount: { accountId: string; calls: number; amountMicros: number; lastAt: number | null }[]
    byConnector: { connector: string; label: string; calls: number; amountMicros: number }[]
    byTool: { connector: string; tool: string; calls: number; amountMicros: number }[]
  }> {
    const f = filterSql([['"accountId"', scope.accountId], ['"companyId"', scope.companyId]], range)
    const args = f.args
    // 维度在 connector_calls（label / tool / 状态），钱在账本，按 refId 接起来。
    const w = ('1=1' + f.sql).replace(/"(accountId|companyId|createdAt)"/g, 'c."$1"')
    // 账本先收成一行：refId 不是唯一键，同一次调用挂两行账会让 calls 和金额一起翻倍。
    const from =
      'from connector_calls c left join ' + LEDGER_BY_REF + ' u on u."refId" = c.id'
    const g = async (cols: string, group: string) =>
      this.many(
        `select ${cols}, count(*) as calls, coalesce(sum(u.micros), 0) as micros, max(c."createdAt") as "lastAt" ${from} where ${w} group by ${group}`,
        args,
      )

    const total = await this.one(
      `select count(*) as calls, coalesce(sum(u.micros), 0) as micros, max(c."createdAt") as "lastAt" ${from} where ${w}`,
      args,
    )
    const byStatus = await g('c.status', 'c.status')
    const byAccount = await g('c."accountId"', 'c."accountId"')
    const byConnector = await g('c.connector, c.label', 'c.connector, c.label')
    const byTool = await g('c.connector, c.tool', 'c.connector, c.tool')
    return {
      total: { calls: num(total?.calls ?? 0), amountMicros: num(total?.micros ?? 0), lastAt: numOrNull(total?.lastAt) },
      byStatus: byStatus.map((r) => ({ status: str(r.status), calls: num(r.calls), amountMicros: num(r.micros) })),
      byAccount: byAccount.map((r) => ({
        accountId: str(r.accountId),
        calls: num(r.calls),
        amountMicros: num(r.micros),
        lastAt: numOrNull(r.lastAt),
      })),
      byConnector: byConnector.map((r) => ({
        connector: str(r.connector),
        label: str(r.label || ''),
        calls: num(r.calls),
        amountMicros: num(r.micros),
      })),
      byTool: byTool.map((r) => ({
        connector: str(r.connector),
        tool: str(r.tool),
        calls: num(r.calls),
        amountMicros: num(r.micros),
      })),
    }
  }

  /** 平台统计的底表：按 (公司, 连接器) 汇总。owner 的调用 companyId 为 null，原样留着。 */
  async connectorUsageByCompany(range?: { from?: number; to?: number }): Promise<
    { companyId: string | null; connector: string; calls: number; amountMicros: number; lastAt: number | null }[]
  > {
    const { sql: where, args } = filterSql([], range)
    // 同文件别处一样先按 refId 汇总再 join：直接 join 账本的话，一次调用落了两行账
    // （被拒一行 + 成功一行）会把 count(*) 也算成两次调用。
    const rows = await this.many(
      `select c."companyId", c.connector, count(*) as calls,
              coalesce(sum(u.micros), 0) as micros, max(c."createdAt") as "lastAt"
       from connector_calls c left join ${LEDGER_BY_REF} u on u."refId" = c.id
       where ${('1=1' + where).replace(/"createdAt"/g, 'c."createdAt"')}
       group by c."companyId", c.connector order by c."companyId", c.connector`,
      args,
    )
    return rows.map((r) => ({
      companyId: strOrNull(r.companyId),
      connector: str(r.connector),
      calls: num(r.calls),
      amountMicros: num(r.micros),
      lastAt: numOrNull(r.lastAt),
    }))
  }

  // ── 计费账本。**钱只在这张表里**，领域表只记事实。见 docs/billing.md。───

  async insertUsageCharge(input: {
    companyId: string | null
    accountId: string
    botId?: string | null
    sessionId?: string | null
    kind: ChargeKind
    subject: string
    status: ChargeStatus
    quantity?: Record<string, number>
    unitPrice?: Record<string, number>
    multiplier?: number
    amountMicros?: number
    bonusMicros?: number
    unpriced?: boolean
    /** 用量是估的。只是落个标记，金额和桶的算法一字不改。 */
    estimated?: boolean
    refId?: string | null
    /**
     * 赠送桶的上限：本账期一共送了多少微元、账期从哪一刻起。给了它，`bonusMicros` 就
     * 不信调用方算的那个数，而是在**同一条 insert 里**按库里已扣的 sum 现算——
     * `least(amount, greatest(0, grant − sum_so_far))`。几十次并发落账各自读到同一份
     * 「还剩 $0.30」时，内存里算出来的 bonus 会把赠送桶扣穿，超出的那截本该走充值桶
     * （docs/billing.md §6.1 的公式）。要真挡住并发，调用方还得先拿 lockCompanyLedger。
     */
    bonusCap?: { grantMicros: number; since: number }
  }): Promise<UsageCharge> {
    const amount = Math.max(0, Math.trunc(input.amountMicros ?? 0))
    const row: UsageCharge = {
      id: randomUUID(),
      companyId: input.companyId,
      accountId: input.accountId,
      botId: input.botId ?? null,
      sessionId: input.sessionId ?? null,
      kind: input.kind,
      subject: input.subject,
      status: input.status,
      quantity: input.quantity ?? {},
      unitPrice: input.unitPrice ?? {},
      multiplier: input.multiplier ?? 1,
      amountMicros: amount,
      // 赠送承担的不可能超过总额——脏数据也不能算出负的「充值承担」（同 0005 的处理）。
      bonusMicros: Math.min(Math.max(0, Math.trunc(input.bonusMicros ?? 0)), amount),
      unpriced: input.unpriced === true,
      estimated: input.estimated === true,
      originalAmountMicros: null,
      adjustedAt: null,
      adjustedBy: null,
      adjustNote: '',
      refId: input.refId ?? null,
      createdAt: Date.now(),
    }
    const cap = input.bonusCap && row.companyId ? input.bonusCap : undefined
    const bonusSql = cap
      ? 'least(?, greatest(0, ? - coalesce((select sum("bonusMicros") from usage_charges where "companyId" = ? and "createdAt" >= ?), 0)))'
      : '?'
    const bonusArgs = cap
      ? [amount, Math.max(0, Math.trunc(cap.grantMicros)), row.companyId, cap.since]
      : [row.bonusMicros]
    const r = await this.one(
      `insert into usage_charges (id, "companyId", "accountId", "botId", "sessionId", kind, subject, status, quantity, "unitPrice", multiplier, "amountMicros", "bonusMicros", unpriced, estimated, "refId", "createdAt")
       values (?,?,?,?,?,?,?,?,?,?,?,?,${bonusSql},?,?,?,?) returning "bonusMicros"`,
      [
        row.id,
        row.companyId,
        row.accountId,
        row.botId,
        row.sessionId,
        row.kind,
        row.subject,
        row.status,
        JSON.stringify(row.quantity),
        JSON.stringify(row.unitPrice),
        row.multiplier,
        row.amountMicros,
        ...bonusArgs,
        row.unpriced,
        row.estimated,
        row.refId,
        row.createdAt,
      ],
    )
    // 库里算出来的才是真扣掉的那份，调用方据此更新自己的余额记忆。
    if (r) row.bonusMicros = num(r.bonusMicros)
    return row
  }

  /**
   * 把清扫写下的**占位行**填成真的。**这是 docs/billing.md §2「金额写死不重算」唯一的
   * 例外**，开这个口子的理由和它的边界都在那里，动之前先读那一节。
   *
   * 场景只有一个：一次长回答跑过了 LLM_SETTLE_GRACE_MS，清扫（routines.ts 的
   * sweepUnsettledLlmCalls）先把它按 `failed` / 0 元 / unpriced 收了口；管家随后带着真实
   * 用量回来。幂等挡住的本该是「同一次调用收两笔钱」，可它连带着把**第一笔也钉成了 0**
   * ——这次调用真金白银发生过，账上却永远是 0，而且补不回来。
   *
   * 所以这里不是「改一笔已经成交的钱」，是**把一行从来没成交过的占位补成成交**。判据
   * 严到只认清扫写出来的那个形状，一格都不能松：
   *
   *   refId 指着这一次调用 · kind = llm · status = failed · unpriced · 金额 0 · 赠送 0 ·
   *   四项 token 全 0
   *
   * 少一格就可能把一笔真收过的钱盖掉：`denied`（闸拒的，是事实）、金额非 0 的（已经成交）、
   * 带用量的（已经结过）各自都会因为某一格对不上而落空。对不上就一行都不动、回 undefined，
   * 调用方退回原来的「只补 token」。
   *
   * **是 update 不是 delete + insert**：账本只增不改是这张表的性格，破一次口子也要破得最
   * 小——行还是那一行、id 还是那个 id，只是不再说假话。
   *
   * **只改一行，靠子查询挑 id，不靠 `refId` 直接筛。** `usage_charges."refId"` 上只有普通
   * 索引不是唯一约束，同一次调用挂两行账是这套代码明说过会发生的事（见 LEDGER_BY_REF
   * 那段注释，以及 routines.ts 里清扫那个「两边同时 insert」的竞态窗口）。以前无所谓：
   * 两行占位都是 0 元，`sum` 起来还是 0。可一旦补录按 `refId` 筛，两行会**各自**被填成
   * 全额——这次调用就收了两遍，而 `this.one()` 只看得见其中一行，余额记忆也只减一份。
   *
   * 外面那串判据（0 元、0 赠送、unpriced、failed）在挑中 id 之后**再查一遍**：两个并发的
   * 补录抢同一行时，第二个等到行锁之后重查会发现它已经不是 0 元了，回 0 行，退回 already。
   * 剩下那行没被选中的占位仍旧是 0 元，按 refId 汇总时和从前一样合成一行。
   *
   * `createdAt` 不动：那是清扫写下的时刻，比「管家什么时候想起来回来」更接近调用真实发生
   * 的时间，改它会把这笔钱挪到另一个账期去。
   *
   * 四项 token 那几刀转的是 `numeric` 不是 `bigint`：`kind = 'llm'` 和这几个转换之间没有
   * 求值顺序的保证，真扫到一行小数用量（上游报了 `1000.5`）时 `::bigint` 会当场报错，
   * 而 `::numeric` 认。
   */
  async fillPlaceholderCharge(input: {
    refId: string
    companyId: string | null
    status: ChargeStatus
    quantity?: Record<string, number>
    unitPrice?: Record<string, number>
    multiplier?: number
    amountMicros?: number
    unpriced?: boolean
    /** 同 insertUsageCharge。给了它，赠送那一份由库在同一条 SQL 里现算。 */
    bonusCap?: { grantMicros: number; since: number }
  }): Promise<UsageCharge | undefined> {
    const amount = Math.max(0, Math.trunc(input.amountMicros ?? 0))
    const cap = input.bonusCap && input.companyId ? input.bonusCap : undefined
    /**
     * 赠送那一份和 insertUsageCharge 同一条公式（sum 里数上自己这一行无所谓——占位行的
     * bonusMicros 一定是 0），外面多套一层 `case when u."createdAt" >= ?`。
     *
     * **那一刀是必须的。** 占位行是清扫写的，它的时间戳可能落在**上一个账期**里，而赠送
     * 桶的上限只数当期（`createdAt >= since`）。给一行上一账期的行记了 bonus，这笔 bonus
     * 不会进后续的 sum，赠送桶就被扣穿了。跨期的那种一律走充值桶。
     */
    const bonusSql = cap
      ? 'case when u."createdAt" >= ? then least(?, greatest(0, ? - coalesce((select sum(c."bonusMicros") from usage_charges c where c."companyId" = ? and c."createdAt" >= ?), 0))) else 0 end'
      : '?'
    const bonusArgs = cap
      ? [cap.since, amount, Math.max(0, Math.trunc(cap.grantMicros)), input.companyId, cap.since]
      : [0]
    const r = await this.one(
      `update usage_charges u set
         status = ?, quantity = ?, "unitPrice" = ?, multiplier = ?,
         "amountMicros" = ?, "bonusMicros" = ${bonusSql}, unpriced = ?
       where u.id = (
               select c2.id from usage_charges c2
                where c2."refId" = ? and c2.kind = 'llm' and c2.status = 'failed' and c2.unpriced = true
                  and c2."amountMicros" = 0 and c2."bonusMicros" = 0
                  and coalesce((c2.quantity->>'promptTokens')::numeric, 0) = 0
                  and coalesce((c2.quantity->>'completionTokens')::numeric, 0) = 0
                  and coalesce((c2.quantity->>'cachedTokens')::numeric, 0) = 0
                  and coalesce((c2.quantity->>'cacheWriteTokens')::numeric, 0) = 0
                order by c2."createdAt", c2.id
                limit 1
             )
         and u.kind = 'llm' and u.status = 'failed' and u.unpriced = true
         and u."amountMicros" = 0 and u."bonusMicros" = 0
       returning *`,
      [
        input.status,
        JSON.stringify(input.quantity ?? {}),
        JSON.stringify(input.unitPrice ?? {}),
        input.multiplier ?? 1,
        amount,
        ...bonusArgs,
        input.unpriced === true,
        input.refId,
      ],
    )
    return r ? usageChargeOf(r) : undefined
  }

  /**
   * 一家公司的账本锁。insertUsageCharge 的 `bonusCap` 是「读 sum 再写」——两次并发
   * 落账各自读到同一个 sum 仍会把赠送桶扣穿，所以落账那一条 insert 要排队。
   * **必须在 db.tx 里调**（同 lockExclusive）。按公司散列，不同公司互不等。
   */
  /**
   * 一次模型调用的结算锁：「这次调用有没有落过账」和「落账」要在它底下成对做完。
   * **先拿它、再拿账本锁**（meter.charge 里那把），各处同一个顺序，不会互等。
   */
  async lockLlmSettle(callId: string): Promise<void> {
    await this.xactLock('lockLlmSettle', `llm_settle:${callId}`)
  }

  async lockCompanyLedger(companyId: string): Promise<void> {
    await this.xactLock('lockCompanyLedger', `usage_charges:${companyId}`)
  }

  /**
   * 这家公司在两个桶上各花了多少（微元）。**三条计费路一起算**——账本是唯一的钱。
   *
   * - **套餐赠送**跟着账期，到期作废，所以只统计 `bonusSince`（当前账期起点）之后的。
   * - **充值**不过期，累计全部历史。
   *
   * 合成一个数的话，套餐一到期，它已经花掉的部分会从充值余额上再扣一遍（见迁移 0005）。
   */
  async chargeSpend(companyId: string, bonusSince: number | null): Promise<{ bonusMicros: number; topupMicros: number }> {
    const topup = await this.one(
      'select coalesce(sum("amountMicros" - "bonusMicros"), 0) as spent from usage_charges where "companyId" = ?',
      [companyId],
    )
    const bonus =
      bonusSince == null
        ? undefined
        : await this.one(
            'select coalesce(sum("bonusMicros"), 0) as spent from usage_charges where "companyId" = ? and "createdAt" >= ?',
            [companyId, bonusSince],
          )
    return { bonusMicros: num(bonus?.spent ?? 0), topupMicros: num(topup?.spent ?? 0) }
  }

  /** 从某个时刻起一共扣了多少微元。账单屏的「本期已扣」用它。 */
  async chargeSpentSince(companyId: string, since: number): Promise<number> {
    const r = await this.one(
      'select coalesce(sum("amountMicros"), 0) as spent from usage_charges where "companyId" = ? and "createdAt" >= ?',
      [companyId, since],
    )
    return num(r?.spent ?? 0)
  }

  async usageCharge(id: string): Promise<UsageCharge | undefined> {
    const r = await this.one('select * from usage_charges where id = ?', [id])
    return r ? usageChargeOf(r) : undefined
  }

  /**
   * 计费明细一页。游标是 `${createdAt}:${id}`，和会话索引那套一样（routes/sessions.ts）。
   *
   * **必须接口分页。** 平台那四张长表是前端切页的（一次拉齐、切的是已经拿到的数据），
   * 理由是「问题不在拉不动，在一屏塞不下」。账本不一样：一家公司一天就能产生几千行，
   * 一次拉齐是真的拉不动。
   */
  async listUsageCharges(filter: {
    companyId?: string
    accountId?: string
    botId?: string
    kind?: ChargeKind
    status?: ChargeStatus
    from?: number
    to?: number
    limit?: number
    before?: { createdAt: number; id: string }
  }): Promise<UsageCharge[]> {
    const { sql: where, args } = chargeFilterSql(filter)
    let sql = 'select * from usage_charges where 1=1' + where
    if (filter.before) {
      // 同一毫秒里可能有好几行，光比时间会漏掉或重复。带上 id 当第二把钥匙。
      sql += ' and ("createdAt", id) < (?, ?)'
      args.push(filter.before.createdAt, filter.before.id)
    }
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? CHARGE_PAGE_DEFAULT), 1), CHARGE_PAGE_MAX + 1)
    sql += ' order by "createdAt" desc, id desc limit ?'
    args.push(limit)
    return (await this.many(sql, args)).map(usageChargeOf)
  }

  /**
   * 重算要的那一批行：同一套筛选，不分页，**多取一行**好让调用方知道截断了没有。
   * 截断了就该让人把范围缩小，而不是悄悄只算前面一截——那样「应用」按下去改了一半。
   */
  async usageChargesForRecalc(
    filter: { companyId?: string; kind?: ChargeKind; from?: number; to?: number },
    limit: number,
  ): Promise<{ rows: UsageCharge[]; truncated: boolean }> {
    const { sql: where, args } = chargeFilterSql(filter)
    const rows = await this.many(`select * from usage_charges where 1=1${where} order by "createdAt" desc, id desc limit ?`, [...args, limit + 1])
    const truncated = rows.length > limit
    return { rows: (truncated ? rows.slice(0, limit) : rows).map(usageChargeOf), truncated }
  }

  /**
   * **人工改一行的金额**（docs/billing.md §2.2）。owner 在明细页上显式操作，或者按当前单价重算。
   *
   * 赠送那一份怎么跟着动：**只减不加**。金额改小，`bonusMicros` 跟着压到不超过新金额；金额
   * 改大，多出来的那截全记充值桶，`bonusMicros` 原地不动。往赠送桶里加要重新算当期的上限
   * （insertUsageCharge 的 bonusCap），而那个上限是「此刻」的，不是这一行落账那一刻的——
   * 补进去的 bonus 可能把早就用光的赠送桶扣穿。多出来的记充值桶永远不会扣穿谁。
   *
   * `originalAmountMicros` 只在第一次改时记下：`coalesce(原值, 当前金额)`。单价快照和倍率
   * 只有重算那条路会给（它换了单价，快照得跟着换，不然四项乘出来对不上金额）；人工改金额
   * 不动它们——那一行的「单价 × 计量 ≠ 金额」正是人工改过的痕迹。
   *
   * 要在 db.tx 里调，外面先拿这家公司的账本锁：余额判定是按公司 sum 的，改金额和落账
   * 得排队。
   */
  async adjustUsageCharge(
    id: string,
    input: { amountMicros: number; by: string | null; note: string; unitPrice?: Record<string, number>; multiplier?: number; unpriced?: boolean },
  ): Promise<UsageCharge | undefined> {
    const amount = Math.max(0, Math.trunc(input.amountMicros))
    const sets = ['"amountMicros" = ?', '"bonusMicros" = least("bonusMicros", ?)', '"originalAmountMicros" = coalesce("originalAmountMicros", "amountMicros")', '"adjustedAt" = ?', '"adjustedBy" = ?', '"adjustNote" = ?']
    const args: unknown[] = [amount, amount, Date.now(), input.by, input.note.slice(0, 500)]
    if (input.unitPrice) {
      sets.push('"unitPrice" = ?')
      args.push(JSON.stringify(input.unitPrice))
    }
    if (input.multiplier != null) {
      sets.push('multiplier = ?')
      args.push(input.multiplier)
    }
    if (input.unpriced != null) {
      sets.push('unpriced = ?')
      args.push(input.unpriced)
    }
    args.push(id)
    const r = await this.one(`update usage_charges set ${sets.join(', ')} where id = ? returning *`, args)
    return r ? usageChargeOf(r) : undefined
  }

  /**
   * 重算落账：一批行一条 UPDATE（同 adjustUsageCharge 的规矩：赠送只减不加、原金额只记第一次、
   * 单价快照和倍率换成重算出来的）。一行一条事务的话，几千行就是几千次锁和往返，在 Vercel 上
   * 一次请求跑不完还会停在半截。调用方按公司分组、拿着账本锁调它；这里只管 SQL。
   *
   * VALUES 里的参数要显式转型：PG 推不出一列 `?` 的类型，`jsonb` 和 `bigint` 那两列尤其。
   */
  async adjustUsageChargesBulk(
    items: { id: string; amountMicros: number; unitPrice: Record<string, number>; multiplier: number }[],
    meta: { by: string | null; note: string },
  ): Promise<number> {
    let n = 0
    const CHUNK = 500
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK)
      const values = chunk.map(() => '(?::text, ?::bigint, ?::jsonb, ?::real)').join(', ')
      const args: unknown[] = [Date.now(), meta.by, meta.note.slice(0, 500)]
      for (const it of chunk) args.push(it.id, Math.max(0, Math.trunc(it.amountMicros)), JSON.stringify(it.unitPrice), it.multiplier)
      n += await this.run(
        `update usage_charges u set
           "amountMicros" = v.amount,
           "bonusMicros" = least(u."bonusMicros", v.amount),
           "originalAmountMicros" = coalesce(u."originalAmountMicros", u."amountMicros"),
           "unitPrice" = v.unit,
           multiplier = v.mult,
           unpriced = false,
           "adjustedAt" = ?, "adjustedBy" = ?, "adjustNote" = ?
         from (values ${values}) as v(id, amount, unit, mult)
         where u.id = v.id`,
        args,
      )
    }
    return n
  }

  /**
   * 账本汇总：按公司 × 类型。统计屏用它。
   *
   * **只 sum，不按当前单价重算**——金额在写行那一刻就定死了（docs/billing.md §2）。
   *
   * 「金额算不出来」的那些行分两格报，**不要再合回一格**：`unpricedCalls` 是目录里没有
   * 单价，owner 去配置页补上就好了；`unmeteredCalls` 是有单价但结算时没拿到用量（上游
   * 流里一个 usage 字段都没回、管家没回来结算被清扫收了口），那一次的用量已经没了，
   * 补不回来。合成一格的表现是统计屏只能挑一句话说，而这两句话要人办的事正好相反。
   */
  async chargeUsageBy(
    columns: ('companyId' | 'accountId' | 'botId' | 'kind' | 'subject')[],
    range?: { from?: number; to?: number },
    filter?: { companyId?: string; accountId?: string },
  ): Promise<{ companyId: string | null; accountId: string; botId: string | null; kind: string; subject: string; calls: number; amountMicros: number; bonusMicros: number; costMicros: number; unpricedCalls: number; unmeteredCalls: number; lastAt: number | null }[]> {
    const cols = columns.map((c) => `"${c}"`).join(', ')
    const r = this.llmRangeSql(range)
    let where = `where 1=1${r.sql}`
    const args: unknown[] = [...r.args]
    if (filter?.companyId) {
      where += ' and "companyId" = ?'
      args.push(filter.companyId)
    }
    if (filter?.accountId) {
      where += ' and "accountId" = ?'
      args.push(filter.accountId)
    }
    const rows = await this.many(
      `select ${cols}, count(*) as calls,
              coalesce(sum("amountMicros"), 0) as "amountMicros",
              coalesce(sum("bonusMicros"), 0) as "bonusMicros",
              -- 原价是**倒推**的：成交额 ÷ 当时的倍率。账本存倍率而不是原价，因为
              -- 倍率只有一个数、原价有四项；除法在这里做，历史行各按各的倍率还原。
              coalesce(sum("amountMicros" / greatest(multiplier, 0.0001)), 0) as "costMicros",
              -- unpriced 是「金额算不出来」，两种原因共用这一格，事后要分开报，因为
              -- 一种现在就能修、另一种修不了（见上面那段注释）。分界是行上那份单价
              -- 快照空不空：查不到单价时 quote 存的是空对象，查得到但没拿到用量时存
              -- 的是四项齐全的快照（lib/meter.ts 的 quote、lib/llm-billing.ts 的 settle）。
              coalesce(sum(case when unpriced and "unitPrice" = '{}'::jsonb then 1 else 0 end), 0) as "unpricedCalls",
              coalesce(sum(case when unpriced and "unitPrice" <> '{}'::jsonb then 1 else 0 end), 0) as "unmeteredCalls",
              max("createdAt") as "lastAt"
       from usage_charges ${where}
       group by ${cols}`,
      args,
    )
    return rows.map((row) => ({
      companyId: columns.includes('companyId') ? strOrNull(row.companyId) : null,
      accountId: columns.includes('accountId') ? str(row.accountId) : '',
      // 模型那条路还填不上 botId（`/v1/*` 收到的请求里没有会话这个概念，见 lib/meter.ts），
      // 所以这一维只覆盖填得上的那些调用。null 原样留着，由上层决定怎么标。
      botId: columns.includes('botId') ? strOrNull(row.botId) : null,
      kind: columns.includes('kind') ? str(row.kind) : '',
      subject: columns.includes('subject') ? str(row.subject) : '',
      calls: num(row.calls),
      amountMicros: num(row.amountMicros),
      bonusMicros: num(row.bonusMicros),
      costMicros: Math.round(num(row.costMicros)),
      unpricedCalls: num(row.unpricedCalls),
      unmeteredCalls: num(row.unmeteredCalls),
      lastAt: numOrNull(row.lastAt),
    }))
  }
}
