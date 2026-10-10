/**
 * @satuwork/core 的出口。
 *
 * gateway/scripts/build-core.mjs 把这个文件打成 gateway/ui/core.js，这里 export 的每一个名字
 * 就是浏览器里 `SatuCore.<名字>`。Web 端的转接写在 state.js / i18n.js 里，一行一个。
 */
export { dict } from './i18n/dict.ts'
export { esc, SATU_TZ, tzOffsetMs, tzDayStart, tzDayKey, fmtTime, dayStart, dayEnd, money, usd, fmtTokens } from './format.ts'
export type { Locale } from './format.ts'
export { connectorIdOfPath, botIdOfPath, companyIdOfPath, machineIdOfPath, userIdOfPath, sessionIdOfPath, auditItemIdOfPath } from './paths.ts'
