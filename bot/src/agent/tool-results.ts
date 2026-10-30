import type { ContentBlock, Usage } from '../session/types.ts'
import { EMPTY_USAGE } from './types.ts'

/** pi 交回来的东西 → 我们落盘的形状：工具结果逐字段挑、内容块、usage。 */

/**
 * 落进日志的工具正文。
 *
 * **只取第一块**：bridgeTools 把工具自己的 text 放在第一块，后面跟的是按**这一轮的模型**
 * 追加的东西——图片块，或者「这颗模型看不了图」「图读不出来」这类说明。那些不是工具的
 * 结果，是这一轮的临时处理；写进日志的话，下一轮回放时 toAgentMessages 会按那一轮的模型
 * 再追加一遍，同一句说明出现两次，或者换了能看图的模型之后一边说「看不了图」一边带着图。
 */
export function textOf(result: any): string {
  if (typeof result === 'string') return result
  const content = result?.content
  if (Array.isArray(content)) {
    const first = content[0]
    if (first?.type === 'text' || (first && typeof first.text === 'string')) return String(first.text ?? '')
    return content.map((c: any) => c?.text ?? '').join('')
  }
  return JSON.stringify(result ?? null)
}

/** details 里的审计原文。逐字段挑，绝不把整个 details 落盘。 */
export function rawTextOf(result: any): string | undefined {
  return typeof result?.details?.rawText === 'string' ? result.details.rawText : undefined
}

/**
 * 工具拍的那张页面截图（见 tools/index.ts 的 `ToolResult.shot`）。
 *
 * 和 filesOf 同一条理由逐字段挑：details 是 `unknown`，原样落盘等于让任意一个工具
 * 决定会话日志的形状。
 */
export function shotOf(result: any): { path: string; name: string } | undefined {
  const raw = result?.details?.shot
  if (typeof raw?.path !== 'string' || !raw.path) return undefined
  return { path: raw.path, name: typeof raw.name === 'string' ? raw.name : raw.path }
}

/** 工具交给模型看的图（ToolResult.images）。逐字段挑，理由同 filesOf。 */
export function imagesOf(result: any): { path: string; mime: string }[] | undefined {
  const raw = result?.details?.images
  if (!Array.isArray(raw)) return undefined
  const out = raw
    .filter((x: any) => typeof x?.path === 'string' && x.path)
    .map((x: any) => ({ path: x.path as string, mime: typeof x.mime === 'string' && x.mime ? x.mime : 'image/png' }))
  return out.length ? out : undefined
}

/**
 * 工具报出来的产出文件（见 tools/index.ts 的 `ToolResult.files`）。
 *
 * 逐字段挑而不是整个 details 塞进日志：details 是 `unknown`，工具想放什么都行，
 * 原样落盘等于让任意一个工具决定会话日志的形状。
 */
export function filesOf(result: any): { path: string; name: string }[] | undefined {
  return pickFiles(result?.details?.files)
}

/**
 * 工具报出来的「看到的文件」（见 tools/index.ts 的 `ToolResult.refs`）。
 *
 * 和 files 走同一道挑拣、落在同一条 `tool/result` 上，但**不能合成一个字段**：
 * 界面对这两样的处理完全不同——产出摆成药丸，看到的只用来把正文里的文件名接成链接。
 */
export function refsOf(result: any): { path: string; name: string }[] | undefined {
  return pickFiles(result?.details?.refs)
}

/** details 是 `unknown`，逐字段挑（理由见 filesOf）。 */
function pickFiles(raw: any): { path: string; name: string }[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const files = raw
    .filter((f: any) => typeof f?.path === 'string' && typeof f?.name === 'string')
    .map((f: any) => ({ path: f.path as string, name: f.name as string }))
  return files.length ? files : undefined
}

export function toUsage(u: any): Usage {
  if (!u) return EMPTY_USAGE
  return {
    /**
     * 写缓存的那截也是这次真发出去的提示词，算进输入。Anthropic 的 input 不含它（也不含
     * 缓存命中），首轮建缓存时它往往占了提示词的大头——不算的话 observedPromptTokens
     * 低估一大截，压缩触发得晚。我们的 Usage 没有单独的写缓存一格，并进 inputTokens。
     */
    inputTokens: (u.input ?? 0) + (u.cacheWrite ?? 0),
    outputTokens: u.output ?? 0,
    cacheReadTokens: u.cacheRead ?? 0,
    reasoningTokens: u.reasoning ?? 0,
    cost: u.cost?.total,
  }
}

/** pi 的内容块 → 我们的。 */
export function fromAgentContent(content: any[]): ContentBlock[] {
  const out: ContentBlock[] = []
  for (const c of content) {
    if (c?.type === 'text') out.push({ type: 'text', text: c.text })
    else if (c?.type === 'thinking') out.push({ type: 'reasoning', text: c.thinking ?? c.text ?? '' })
    else if (c?.type === 'toolCall')
      out.push({
        type: 'tool-call',
        callId: c.id,
        name: c.name,
        arguments: JSON.stringify(c.arguments ?? {}),
      })
  }
  return out
}

/** 我们的 usage → pi 的形状。字段名不同，且它多一个 totalTokens 与分项成本。 */
export function piUsage(u: Usage | undefined) {
  const input = u?.inputTokens ?? 0
  const output = u?.outputTokens ?? 0
  return {
    input,
    output,
    cacheRead: u?.cacheReadTokens ?? 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u?.cost ?? 0 },
  }
}
