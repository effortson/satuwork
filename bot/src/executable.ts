import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * 找一个本机程序（浏览器、LibreOffice）：显式覆盖 → 各平台的固定安装位置 → PATH。
 *
 * - 覆盖变量给了就只认它：指向的文件不存在回 null，**不回落**到别的候选——公司把程序装在
 *   非标准位置时，悄悄换成另一个版本比明说「找不到」更难查。
 * - 只挑已经存在的文件，不跑 `which` / shell：路径不该变成一段能执行的命令。
 *
 * `names` 是在 PATH 各目录里找的文件名，`fixed` 是固定位置，调用方按平台给好。
 */
export function findExecutable(override: string | undefined, names: string[], fixed: string[]): string | null {
  const forced = override?.trim()
  if (forced) return existsSync(forced) ? forced : null
  const onPath = names.flatMap((name) =>
    (process.env.PATH || '').split(delimiter).filter(Boolean).map((dir) => join(dir, name)),
  )
  return [...fixed, ...onPath].find((candidate) => existsSync(candidate)) ?? null
}
