/**
 * 输入框里的 `@` 点名和斜杠命令：认不认、认成什么。原先在 gateway/ui/chat.js，只碰字符串。
 *
 * 命令表本身（CHAT_COMMANDS）还在 chat.js：每条命令的 `run` 是对接口的一次调用，那是界面的事。
 * 所以这里按参数收表，只管「这一串字是不是命令、是哪一条」。
 */

/** 命令表里这一层只看名字。 */
export interface CommandLike {
  name: string
}

/** 光标前面刚打出来的 `@xxx`。不在词首（前面挨着字母）不算，邮箱地址不该触发选单。 */
export function mentionQueryAt(value: string, pos: number): { at: number; q: string } | null {
  const before = value.slice(0, pos)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  const prev = at > 0 ? before[at - 1] : ' '
  if (!/[\s(（]/.test(prev)) return null
  const word = before.slice(at + 1)
  if (/[\s\n]/.test(word)) return null
  return { at, q: word }
}

/**
 * 输入框开头那条 `/xxx`。
 *
 * 判据比 `@` 严一档：**必须在最开头，而且后面只跟命令名**。斜杠在正文里太常见——
 * `/etc/hosts`、「他说的 /compact 是什么意思」、贴一段路径——那些都不该弹选单，
 * 更不该被当成命令执行。而命令本来就占满整条消息，不和正文混着发。
 */
export function commandQueryAt(value: string, pos: number): { q: string } | null {
  const before = value.slice(0, pos)
  if (!/^\/[a-zA-Z-]*$/.test(before)) return null
  return { q: before.slice(1).toLowerCase() }
}

/** 选单里列哪几条：按前缀筛，什么都没打就全列。 */
export function cmdMatches<C extends CommandLike>(q: string, commands: C[]): C[] {
  return commands.filter((c) => !q || c.name.startsWith(q))
}

export type ParsedCommand<C> = { cmd: C; extra?: true; arg?: string } | { unknown: string }

/**
 * 这条草稿是不是一条命令。
 *
 * 三种结果：命中一条、`{ unknown }`（打了斜杠但不认识）、null（不是命令）。
 * **不认识的不能当普通消息发出去**——一个手滑的 `/copmact` 就发给模型了，它会礼貌地
 * 回一段「你是想…吗」，而人以为自己压缩过了。参数也一样不收：`/compact 只留三轮`
 * 当作不认识，不猜意图。
 */
export function parseCommand<C extends CommandLike>(text: unknown, commands: C[]): ParsedCommand<C> | null {
  const raw = String(text || '').trim()
  const first = raw.split(/\s+/)[0]
  /**
   * **命令名里不会有第二个斜杠。** 这一条把「整条消息就是一个路径」放行——
   * `/etc/hosts`、`/var/log/syslog` 是人真的会单独发过来的一句话（「看下这个文件」的
   * 省略说法），把它拦成「没有这条命令」纯属添乱。而 `/copmact` 这种仍然拦得住，
   * 那才是这道闸要防的。
   */
  if (!/^\/[a-zA-Z-]+$/.test(first)) return null
  const hit = commands.find((c) => c.name === first.slice(1).toLowerCase())
  if (!hit) return { unknown: first }
  // 认得这条，但后面还跟着别的字。只有 `/model` 收参数，别的一律不收——**不猜意图**，
  // 也不把多出来的那半句悄悄丢掉。
  if (raw !== first) return { cmd: hit, extra: true, arg: raw.slice(first.length).trim() }
  return { cmd: hit }
}
