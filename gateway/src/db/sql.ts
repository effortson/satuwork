/** 日线、小时线的桶宽。SQL 里切桶（db.ts 的 bucketSql）和界面上铺柱子（lib/usage.ts）用同一个数。 */
export const DAY_MS = 86400000
export const HOUR_MS = 3600000

/**
 * 「几个等值条件 + createdAt 区间」那段 where，拼成 ` and …` 接在调用方自己的 `where 1=1` 后面。
 *
 * 明细、重算、模型/网页用量、连接器用量四处原先各拼一份，长得一样、差在细节上，改一处的人
 * 不会知道还有另外三处。规矩只此一份：
 *
 * - 等值条件按传进来的顺序拼，参数跟着同一个顺序；值为空（空串 / null / undefined）的跳过——
 *   「不传」和「传空」都是不筛。
 * - 区间两端各自可选，闭区间；0 是一个值，照样拼。
 * - 列名原样进 SQL，由调用方写好引号（驼峰列要 `"companyId"`），这里不碰。
 */
export function filterSql(
  eq: [column: string, value: string | null | undefined][],
  range?: { from?: number; to?: number },
): { sql: string; args: (string | number)[] } {
  let sql = ''
  const args: (string | number)[] = []
  for (const [column, value] of eq) {
    if (!value) continue
    sql += ` and ${column} = ?`
    args.push(value)
  }
  if (range?.from != null) {
    sql += ' and "createdAt" >= ?'
    args.push(range.from)
  }
  if (range?.to != null) {
    sql += ' and "createdAt" <= ?'
    args.push(range.to)
  }
  return { sql, args }
}

/** 派活清扫每一拍每一类最多收多少条。积压了也一拍拍收完，不让一次清扫拖成一条慢查询。 */
export const SWEEP_BATCH = 200

/**
 * 账本按 refId 收成一行，用于所有「维度在业务表、金额在账本」的汇总。
 *
 * `usage_charges."refId"` 上只有普通索引，不是唯一约束，同一次调用完全可能挂上两行账
 * （崩在写调用和记账之间随后重算、或者一条被重放的上报）。直接 join 会把业务表那一行
 * 复制一份——calls 翻倍、token 和金额跟着翻倍。先收再 join，扇出这件事就不存在了。
 */
export const LEDGER_BY_REF = '(select "refId", sum("amountMicros") as micros from usage_charges group by "refId")'

/**
 * 日线 / 小时线切桶用的除数，**拼进 SQL 的字面量**，不走参数：bigint 除以一个绑定参数会按
 * 整数除，floor 在负数上就错了；写成 `86400000.0` 这种带小数点的字面量才是真除法。
 * 只认这两个值，别的都当按天——这里不接受外面传进来的任意数字。
 */
export function bucketSql(bucketMs: number): string {
  return bucketMs === HOUR_MS ? `${HOUR_MS}.0` : `${DAY_MS}.0`
}
