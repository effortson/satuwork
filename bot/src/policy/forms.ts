import type { ToolCall } from '../tools/index.ts'

/**
 * 确认卡上的一格。
 *
 * **`key` 是写回参数用的路径**（点分，`args.body` 这种），不是显示用的名字——界面把改
 * 过的值按这个 key 送回来，席位照着它写回真正要执行的那份参数。两者用同一个 key，
 * 「界面上改的」和「实际发出去的」之间就没有翻译层，也就没有对不上的机会。
 */
export interface ApprovalField {
  key: string
  label: string
  value: string
  /** 人能不能改它。**默认不能**——能改的每一格都要在下面的表里明写出来。 */
  editable?: boolean
  /** 多行（正文那种），界面画 textarea 而不是 input。 */
  multiline?: boolean
}

/**
 * 一次确认要给人看什么、让人改什么。
 *
 * `kind` 决定界面用哪一套样式：`generic` 是那张通用卡（工具名 + 参数 JSON），
 * `email` 是发信那张（收件人、主题、正文，正文可改），`memory` 是记一条事实那张
 * （正文和类别可改，层不可改），`folder` 是本地 Bot 申请访问一个文件夹那张（界面上是
 * 「选择文件夹…」按钮，拉起 Desktop 的系统选择框）。**界面认不出的 kind 一律退回 generic**——新增一种
 * 表单不该让老版本的浏览器白屏。
 */
export interface ApprovalForm {
  kind: 'generic' | 'email' | 'memory' | 'folder'
  /** 真正要跑的那把工具：穿过 SW_RUN 这类元工具之后的名字。 */
  tool: string
  fields: ApprovalField[]
}

/** 元工具的壳。见 gateway/src/lib/tool-search.ts：`{ tool: 'SLUG', args: {…} }`。 */
const RUN_WRAPPER = /_sw_run$/

export interface Unwrapped {
  /** 真正要跑的那把工具。没套壳时就是工具名本身。 */
  tool: string
  /** 真正要跑的那份参数。 */
  args: Record<string, unknown>
  /** 参数在整份 JSON 里的前缀路径。套了壳是 `args`，没套是空。 */
  prefix: string
  /** 整份原始参数（含壳）。写回时要在它上面改。 */
  raw: Record<string, unknown>
}

/**
 * 剥掉元工具的壳。
 *
 * 连接器工具多到装不下时，Gateway 会把它们收成三个元工具（`SW_SEARCH` / `SW_DESCRIBE` /
 * `SW_RUN`），真正的工具名跑到参数里去了。不剥这层壳，确认卡上写的是
 * 「mcp_github_default_sw_run 会往外部系统写入或发送内容」——而它其实只是查了一次仓库
 * 列表。人连自己在批什么都看不出来，那张卡片就只剩「点一下」这一个功能。
 */
export function unwrapCall(call: { name: string; arguments: string }): Unwrapped {
  let raw: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(call.arguments || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>
  } catch {
    // 参数不是合法 JSON：那次调用本来就会在 run() 里失败，这里当没有参数处理。
  }
  if (!RUN_WRAPPER.test(call.name)) return { tool: call.name, args: raw, prefix: '', raw }
  const inner = String(raw.tool ?? '').trim()
  const nested = raw.args
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return { tool: inner || call.name, args: nested as Record<string, unknown>, prefix: 'args', raw }
  }
  /**
   * 有些模型把 args 整个 JSON 字符串化。**只解析给人看，不改写它的形状**——写回时会
   * 把这一格换成对象（Gateway 的 runArgsOf 两种都收），但那是「人改过」才发生的事。
   */
  if (typeof nested === 'string' && nested.trim()) {
    try {
      const parsed = JSON.parse(nested)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { tool: inner || call.name, args: parsed as Record<string, unknown>, prefix: 'args', raw }
      }
    } catch {
      /* 不是 JSON 就当没有 */
    }
  }
  // 平铺写法：`{ tool: 'X', to: 'a@b.c' }`。参数就在顶层，只是要把 tool/args 两格排除掉。
  const { tool: _tool, args: _args, ...rest } = raw
  return { tool: inner || call.name, args: rest, prefix: '', raw }
}

/** 一个字段可能叫的那几个名字。第一个对得上的算数。 */
type Alias = { keys: string[]; label: string; editable?: boolean; multiline?: boolean }

/**
 * 发信这一类的字段。
 *
 * **收件人不可改。** 能改收件人的话，「审一眼要发出去的东西」就变成了「在这儿写封信」
 * ——那是另一件事，而且发错人是这条边界最该防住的后果之一。真发错了，让 Bot 重发一次
 * 比在确认卡上改地址安全：重发会再走一遍这张卡。
 */
const EMAIL_FIELDS: Alias[] = [
  { keys: ['recipient_email', 'to', 'to_email', 'toRecipients', 'recipients', 'email'], label: '收件人' },
  { keys: ['cc', 'cc_email', 'ccRecipients'], label: '抄送' },
  { keys: ['bcc', 'bcc_email', 'bccRecipients'], label: '密送' },
  { keys: ['subject', 'title'], label: '主题', editable: true },
  { keys: ['body', 'message_body', 'html_body', 'text_body', 'message', 'content', 'text'], label: '正文', editable: true, multiline: true },
]

/**
 * 这把工具是不是「把一封信发出去」。
 *
 * 按**动词 + 名词**两头都对上才算，不是看见 mail 就算：`GMAIL_FETCH_EMAILS`、
 * `GMAIL_LIST_DRAFTS` 都带 mail，它们不发东西，套上发信那张卡只会让人以为要发信。
 */
const SEND_VERB = /(^|_)(send|reply|forward|draft)(_|$)/i
const MAIL_NOUN = /(mail|email|message)/i

export function isEmailSend(tool: string): boolean {
  const name = String(tool || '')
  if (!SEND_VERB.test(name)) return false
  if (!MAIL_NOUN.test(name)) return false
  // `SEND_MESSAGE` 这种在聊天工具里也有（Slack），但它同样是「发出去的东西」，
  // 用这张卡片没坏处：字段对不上时下面的 formOf 自己会退回 generic。
  return true
}

function pick(args: Record<string, unknown>, alias: Alias): { key: string; value: string } | null {
  for (const key of alias.keys) {
    const v = args[key]
    if (v === undefined || v === null || v === '') continue
    const value = typeof v === 'string' ? v : Array.isArray(v) ? v.map(String).join(', ') : JSON.stringify(v)
    return { key, value }
  }
  return null
}

/** 一格的路径：套了壳的要带上前缀，写回时才落到真正那份参数上。 */
function pathOf(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key
}

/**
 * 认过的字段之外，剩下那些参数也摆出来、只是不给改。
 *
 * 邮件卡和记忆卡都要这一段，理由一样：藏起来的话，人以为自己看到了这次操作的全部，
 * 而实际发出去的可能带着一个附件。
 */
function pushRest(fields: ApprovalField[], un: Unwrapped, used: Set<string>) {
  for (const [key, value] of Object.entries(un.args)) {
    if (used.has(key)) continue
    fields.push({
      key: pathOf(un.prefix, key),
      label: key,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    })
  }
}

/**
 * 这次调用该用哪张确认卡。
 *
 * 认不出来就 `generic`——**不认识不是理由把参数藏起来**：通用卡把整份 JSON 摆出来，
 * 人照样看得见自己在批什么。
 */
export function formOf(call: { name: string; arguments: string }): ApprovalForm {
  const un = unwrapCall(call)
  if (un.tool === 'memory_write') return memoryForm(un)
  if (!isEmailSend(un.tool)) return { kind: 'generic', tool: un.tool, fields: [] }

  const fields: ApprovalField[] = []
  const used = new Set<string>()
  for (const alias of EMAIL_FIELDS) {
    const hit = pick(un.args, alias)
    // 主题和正文**没有也要给一格**：模型漏了正文时，人得能在这儿补上再发，
    // 而不是只能拒绝然后去跟它解释。收件人那几格没有就不摆——空的收件人不是能补的东西。
    if (!hit && !alias.editable) continue
    const key = hit?.key ?? alias.keys[0]
    used.add(key)
    fields.push({
      key: pathOf(un.prefix, key),
      label: alias.label,
      value: hit?.value ?? '',
      ...(alias.editable ? { editable: true } : {}),
      ...(alias.multiline ? { multiline: true } : {}),
    })
  }
  // 正文都认不出来就别硬套这张卡：字段名跟我们这张表完全对不上的连接器，
  // 通用卡（整份 JSON）比一张空着的邮件卡诚实。
  if (!fields.some((f) => f.multiline && f.value)) return { kind: 'generic', tool: un.tool, fields: [] }

  /**
   * 剩下那些参数（`is_html`、`attachment`、线程 id…）**也要露出来，只是不给改**。
   * 藏起来的话，人以为自己看到了这封信的全部，而实际发出去的可能带着一个附件。
   */
  pushRest(fields, un, used)
  return { kind: 'email', tool: un.tool, fields }
}

/**
 * 记一条事实那张卡。
 *
 * **正文那一格可改，是这张卡最值钱的地方。** 模型多半记对了七成，人真正想做的是
 * 把那句话改准，而不是拒绝、然后回去跟它解释一遍（docs/memory.md §6）。类别也可改
 * ——记错类的代价是它以后按错的那一类被筛掉。
 *
 * **层不可改。** `bot` 和 `self` 决定这句话跨不跨 Bot，那是归属不是措辞；真要改，
 * 删了重记一条比在一张审批卡上顺手拨一下清楚。
 *
 * 剩下的参数也摆出来、只是不给改，同 email 那张卡的理由：藏起来的话，人以为自己
 * 看到了这次写入的全部。
 */
function memoryForm(un: Unwrapped): ApprovalForm {
  const op = typeof un.args.op === 'string' ? un.args.op : ''
  const fields: ApprovalField[] = []
  const used = new Set<string>()
  const put = (key: string, label: string, value: unknown, editable = false, multiline = false) => {
    used.add(key)
    fields.push({
      key: pathOf(un.prefix, key),
      label,
      value: typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value),
      ...(editable ? { editable: true } : {}),
      ...(multiline ? { multiline: true } : {}),
    })
  }
  put('op', '操作', op === 'add' ? '记一条' : op === 'replace' ? '改一条' : op === 'remove' ? '删一条' : op)
  // remove 没有正文可改（要删的那条由 match 认），所以只有前两种摆可改的正文格。
  if (op !== 'remove') put('text', '记什么', un.args.text, true, true)
  if (un.args.match !== undefined) put('match', '改/删哪一条', un.args.match)
  if (op !== 'remove') put('kind', '类别', un.args.kind ?? '事实', true)
  put('layer', '范围', un.args.layer === 'self' ? '这个人所有的 Bot' : '只有这颗 Bot')
  pushRest(fields, un, used)
  return { kind: 'memory', tool: un.tool, fields }
}

/** 单格改动的长度上限。够写一封长信，又不至于让谁把一本书塞进会话日志。 */
const MAX_EDIT_CHARS = 100_000

/**
 * 把人改过的内容写回那份参数。
 *
 * **以席位这边重算出来的表单为准**，不信浏览器送来的 key：那边可以送任何东西，而这里
 * 只认 `editable` 的那几格。少了这一层，「审批」就成了「让前端随便改一份即将执行的
 * 参数」——比不改还危险，因为它看起来是被审过的。
 */
export function applyEdits(
  argumentsJson: string,
  form: ApprovalForm,
  edits: Record<string, unknown>,
): { arguments: string; changed: string[]; fields: ApprovalField[] } {
  const changed: string[] = []
  const fields = form.fields.map((f) => ({ ...f }))
  let raw: Record<string, unknown>
  try {
    const parsed = JSON.parse(argumentsJson || '{}')
    raw = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return { arguments: argumentsJson, changed, fields }
  }

  for (const field of fields) {
    if (!field.editable) continue
    const next = edits[field.key]
    if (typeof next !== 'string') continue
    const value = next.slice(0, MAX_EDIT_CHARS)
    if (value === field.value) continue
    setPath(raw, field.key, value)
    field.value = value
    changed.push(field.label)
  }
  return { arguments: changed.length ? JSON.stringify(raw) : argumentsJson, changed, fields }
}

/**
 * 按点分路径写值。只支持一层嵌套（`args.body`），那正是元工具那层壳的深度。
 *
 * 壳里的 `args` 如果是个 JSON 字符串，这里会把它换成对象——Gateway 的 `runArgsOf`
 * 两种形状都收，而对象是那边文档里写的那一种。
 */
function setPath(raw: Record<string, unknown>, path: string, value: string): void {
  const dot = path.indexOf('.')
  if (dot < 0) {
    raw[path] = value
    return
  }
  const head = path.slice(0, dot)
  const rest = path.slice(dot + 1)
  let nested = raw[head]
  if (typeof nested === 'string') {
    try {
      const parsed = JSON.parse(nested)
      nested = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      nested = {}
    }
  }
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) nested = {}
  ;(nested as Record<string, unknown>)[rest] = value
  raw[head] = nested
}
