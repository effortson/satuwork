/**
 * 几处各抄了一份、一字不差的小帮手。纯函数，不 import 任何东西——connectors/、v1.ts、
 * lib/ 下哪一层用都不会把别的模块拖进来。
 *
 * 同名但口径不同的（db/rows.ts 的 `str` 是裸 `String(v)`，null 会变成 "null"）不在这里，
 * 别「顺手」合进来。
 */

/** 只认字符串；null/undefined 当空串，别的值 String() 一下。 */
export function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/** 是普通对象就原样给，数组、null、标量一律当空对象。 */
export function objOf(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** 错误压成一行、截到 200 字，存进 lastError 那种一格里。 */
export function oneLine(e: unknown): string {
  return String((e as Error)?.message ?? e)
    .replace(/\s+/g, ' ')
    .slice(0, 200)
}
