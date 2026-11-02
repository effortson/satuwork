/**
 * 同一个失败连着撞几次，这一轮就停。
 *
 * 弱一点的模型会把一句拒绝原样再试一遍：工具回「缺少 name」，它照旧不带 name 再调，
 * 一轮里能撞上几十次，直到单轮步数的硬顶（120 步）才停——每一步都带着整份上下文按
 * 输入计费，一轮就是几百万 token，而回给人的什么都没有。步数硬顶管的是「活儿太长」，
 * 管不住「原地打转」。
 *
 * 判据只看**结果**：这一步的工具调用全部没办成，而且是哪把工具、报错原文跟上一步一模一样。
 * 「没办成」有两种：管道层失败（pi 的 `isError`），和工具自己 `fail()` 出来的业务拒绝
 * （`details.refused`，见 ToolResult.refused）——后者才是常见的那种：「缺少 name」是一句
 * 正常返回的文本，不置 `failed`。
 * 不看参数——模型每次可能换个标点、换个措辞，可它撞的是同一堵墙；只要报错原文没变，
 * 就是没听进去。中间成功过一步、或者错误变了，都从头数。
 *
 * 纯函数式的小状态机，探针直接测。
 */

/** 连着几步撞同一个失败就停。`SATUWORK_REPEAT_FAIL_MAX` 可调，0 关掉。 */
export const REPEAT_FAIL_MAX = (() => {
  const raw = (process.env.SATUWORK_REPEAT_FAIL_MAX ?? '').trim()
  const n = Number(raw)
  return raw && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 4
})()

type ToolResultLike = { toolName?: unknown; isError?: unknown; content?: unknown; details?: unknown }

function refused(r: ToolResultLike): boolean {
  return r.isError === true || Boolean(r.details && typeof r.details === 'object' && (r.details as { refused?: unknown }).refused === true)
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : ''))
    .join('\n')
}

export interface FailureStreak {
  /** 喂这一步的工具结果。返回 true = 该停了。 */
  see(results: unknown[]): boolean
  /** 连着撞了几次。 */
  readonly count: number
  /** 撞的是哪把工具。 */
  readonly tool: string
  /** 那句报错（截过的）。 */
  readonly error: string
}

export function failureStreak(max = REPEAT_FAIL_MAX): FailureStreak {
  let last = ''
  let count = 0
  let tool = ''
  let error = ''
  return {
    see(results) {
      const rows = (results as ToolResultLike[]).filter((r) => r && typeof r === 'object')
      const allFailed = rows.length > 0 && rows.every(refused)
      if (!allFailed) {
        last = ''
        count = 0
        return false
      }
      // 报错原文截到 500 字：够分得清是不是同一句，又不至于拿一大段工具输出当钥匙。
      const parts = rows.map((r) => `${String(r.toolName ?? '')}\u0000${textOf(r.content).slice(0, 500)}`).sort()
      const sig = parts.join('\u0001')
      count = sig === last ? count + 1 : 1
      last = sig
      tool = String(rows[0].toolName ?? '')
      error = textOf(rows[0].content).replace(/\s+/g, ' ').trim().slice(0, 120)
      return max > 0 && count >= max
    },
    get count() {
      return count
    },
    get tool() {
      return tool
    },
    get error() {
      return error
    },
  }
}
