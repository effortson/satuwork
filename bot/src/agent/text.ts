import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Message, RefBlock } from '../session/types.ts'

/** 消息和工具表变成文本、估 token。纯函数。 */

/**
 * 估算 token 数。
 *
 * 没有分词器，也不该为了输入框上一行灰字去装一个：那要么按模型各配一份词表，要么把
 * 整段提示词再跑一遍分词。CJK 大致一字一 token，其余按 ~3.6 字符一 token，够撑一条
 * 「占了多少」的提示。**总量不用它**——那个是模型自己回报的，见 usage。
 */
export function estTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length
  return Math.round(cjk + (text.length - cjk) / 3.6)
}

/** 工具表进模型时的实际形状。参数表往往比描述还大，只量描述会差出一大截。 */
export function toolsText(tools: { name: string; description: string; parameters?: unknown }[]): string {
  return tools
    .map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters ?? {} }))
    .join('')
}

export function contentDigest(content: any): string {
  if (!Array.isArray(content)) return String(content ?? '')
  return content
    .map((c: any) => {
      if (c?.type === 'toolCall' || c?.type === 'tool-call') return `[调用 ${c.name}]${argsText(c.arguments)}`
      if (c?.type === 'tool-result') return c.text ?? ''
      // 图片：**不要把 base64 拼进来**。一张 2 MB 的图 base64 之后是 2.7 MB 字符，
      // 拼进摘要输入会瞬间吃满上限，还会把真正有用的对话挤掉。给一句占位就够，
      // 至于它值多少 token 由 estEvent 单独计。
      if (c?.type === 'image') return `[图片 ${c.path ?? c.mimeType ?? ''}]`
      return c?.text ?? ''
    })
    .join('')
}

/**
 * 工具参数转文本。**两种形状的 arguments 不能用同一种转法**：日志事件里它已经是
 * JSON 字符串，再 stringify 一遍会包上引号并转义每个双引号，长度凭空涨五成；
 * pi 的消息里它是对象，必须 stringify 才有内容。转错的代价是估算偏大，
 * compactionPoint 于是切得比需要的早、留的原文比能留的少。
 */
function argsText(args: unknown): string {
  if (args == null) return ''
  return typeof args === 'string' ? args : JSON.stringify(args)
}

/** 一组消息进模型时的估算大小。 */
export function estMessages(messages: AgentMessage[]): number {
  return messages.reduce((n, m: any) => {
    const body = typeof m.content === 'string' ? m.content : contentDigest(m.content)
    return n + estTokens(body) + 4 // 每条消息的角色和分隔开销，粗算
  }, 0)
}

/**
 * 消息里给模型看的那段文本。
 *
 * `mention` 块在这里渲染成一行 `[本轮指定：…]`——**翻译只在这一处**。落盘的是结构
 * （谁被点名了、id 是什么），进模型的是话；两边分开，重放才和当时一致（不变量 7），
 * 而模型也不用认识一种它没见过的块。
 */
export const textFrom = (m: Message, refText: (c: RefBlock) => string = refFallback) =>
  m.content
    .map((c) =>
      c.type === 'text'
        ? c.text
        : c.type === 'mention'
          ? // 混排的点名（inline）就是原句里那个 `@名字`，前后文字原样接上；老格式那一排照旧单独成行。
            c.inline ? `\u0000@${c.label}\u0000` : c.kind === 'bot' ? `[@${c.label}：把这件事派给它]` : `[本轮指定：${c.label}]`
          : c.type === 'ref'
            ? refText(c)
            : '',
    )
    .filter(Boolean)
    .join('\n')
    // 混排的点名两边不能插换行：「打开 @Gmail 邮件」得还是一句话。
    .replace(/\n?\u0000\n?/g, '')

/** `[引用你 … 的回复]` 那一行的称呼。 */
export function refHead(role: 'user' | 'assistant', when: string): string {
  return role === 'assistant' ? `[引用你${when}的回复]` : `[引用用户${when}的消息]`
}

/**
 * 没有日志可查时的渲染（估 token、离线重放、seq 缺失）：只有摘录。
 *
 * **翻译只在 textFrom 这一处**的规矩在引用上也成立——这里和 refTextOf 产出的是同一个
 * 形状，区别只是正文从哪来。
 */
export function refFallback(c: RefBlock): string {
  if (c.kind === 'file') return `[引用文件：\`${c.path}\`]`
  return `${refHead(c.role, '之前')}（只有开头）\n${c.excerpt}\n[引用结束]`
}

export function safeParse(s: string): unknown {
  try {
    return s.trim() ? JSON.parse(s) : {}
  } catch {
    return {}
  }
}
