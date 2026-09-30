import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { WorkspaceError } from '../workspace/index.ts'
import type { ReassignedItem, ToolCall, ToolDelegation, ToolRisk, WorkspaceFile } from './index.ts'

/**
 * 工作区那几把工具共用的一点东西：业务失败怎么表达、结果长什么样、怎么注册。
 *
 * 单独成一个文件而不是各写一份，是因为**「什么算业务失败」必须只有一个口径**：这一层
 * 判错了，模型收到的就是「工具执行失败」这种管道故障的说法，而它对应的动作（重试、
 * 报错给用户）和「文件不存在」完全不一样。
 */

/** 业务失败：参数不对、文件不存在、命令没找到。**不是**管道故障，照常返回文本。 */
export class ToolFailure extends Error {}

export function fail(message: string): never {
  throw new ToolFailure(message)
}

/** 截断并说清楚截了多少。悄悄截掉会让模型以为它看到的就是全部。 */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`
}

/** 工具返回的东西：一段文本，外加它落地的（files）与看到的（refs）文件。 */
export type ToolOut = { text: string; files?: WorkspaceFile[]; refs?: WorkspaceFile[] }

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  risk?: ToolRisk[]
  /** 见 tools/index.ts 的 ToolDelegation。**内置工具必须写**，register 会拦。 */
  delegation?: ToolDelegation
  /** 见 tools/index.ts 的 ToolDefinition.vision。 */
  vision?: boolean
  /** 见 tools/index.ts。标了 `retains` 就必须实现它。 */
  reassign?(from: string, to: string): ReassignedItem[] | Promise<ReassignedItem[]>
}

/**
 * 注册一把工作区工具，顺手把业务失败收成文本。
 *
 * 管道故障（真异常）继续往上抛，由 ToolService 标 `failed`。越界、文件不存在、没权限
 * 这些是模型写错了参数，跟「命令退出码非零」同类——告诉它，让它改。
 */
export function registerTool(
  ctx: Context,
  def: ToolDef,
  execute: (args: any, call: ToolCall) => Promise<string | ToolOut> | string | ToolOut,
) {
  ctx.tools.register({
    ...def,
    async execute(args, call) {
      try {
        const out = await execute((args ?? {}) as any, call)
        return typeof out === 'string' ? { text: out } : out
      } catch (e) {
        if (e instanceof WorkspaceError) return { text: e.message }
        if (e instanceof ToolFailure) return { text: e.message }
        const err = e as NodeJS.ErrnoException
        if (err?.code === 'ENOENT') return { text: `文件或目录不存在：${err.path ?? ''}` }
        if (err?.code === 'EACCES') return { text: `没有权限：${err.path ?? ''}` }
        if (err?.code === 'EISDIR') return { text: `这是一个目录，不是文件：${err.path ?? ''}` }
        throw e
      }
    },
  })
}

/**
 * 遍历时跳过的目录。命中一次 node_modules 就没有下文了。
 *
 * **两个工具集共用一份。** `search_files` 靠它别把 node_modules 翻穿，`terminal` 靠它
 * 别把一次 `pnpm install` 装出来的两万个文件当成「Bot 的产出」——两边跳的是同一批
 * 东西，各写一份迟早会有一边漏。
 */
export const SKIPPED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
  '.next', '.nuxt', '.cache', '.turbo', 'coverage',
  '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', 'target',
  // 命令输出的落盘目录（见 tools/terminal.ts）。那是过程痕迹，不是员工的文件。
  '.satuwork',
])

/**
 * 遍历预算。
 *
 * `truncated` 是**「真的还有东西没看」**，不是「left 归零」。两者差一个文件：`walkFiles`
 * 是「要 yield 之前先减」，所以正好走满预算的那一趟会以 `left === 0` 干干净净地结束，
 * 而调用方按 `left <= 0` 判截断就会把一份完整的结果当成残缺的丢掉。这个标记只在**还
 * 有下一个条目要看却看不了**的时候才置。
 */
export interface WalkBudget {
  left: number
  truncated?: boolean
}

/**
 * 递归列出普通文件。符号链接不跟——跟了会绕圈，也会绕出工作区。
 *
 * `hidden` 为假时以 `.` 开头的条目一律跳过。工作区是员工的办公目录，`.DS_Store`、
 * `.env` 这类东西摆进结果里只会把真正的文件挤下去；要它们就把模式写成 `.env` 这样
 * **以点开头**，那时这个开关自己会打开。
 */
export async function* walkFiles(dir: string, budget: WalkBudget, hidden: boolean, approvedLink?: (path: string) => boolean): AsyncGenerator<string> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (budget.left <= 0) {
      budget.truncated = true
      return
    }
    if (!hidden && entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      if (approvedLink?.(full)) yield* walkFiles(full, budget, hidden, approvedLink)
      continue
    }
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue
      yield* walkFiles(full, budget, hidden, approvedLink)
    } else if (entry.isFile()) {
      budget.left -= 1
      yield full
    }
  }
}
