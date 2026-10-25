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
