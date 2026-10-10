/**
 * 每条会话的翻页状态 `{ firstSeq, hasMore, loading }` 怎么合并。
 *
 * 规矩只有一条：**谁知道得更早，谁说了算。**
 *
 * 三个写入方看到的窗口不一样大——流上只垫一轮，HTTP 一次二十轮，往前翻又是另一页——
 * 而谁先落地取决于网络。窄窗口晚到时如果照写，游标就被推回「最后一轮的开头」，于是
 * 「加载更早的对话」去取的是一页手上全有的事件：归并那两道闸会把它们全滤掉，按钮点了
 * 没反应。
 *
 * `hasMore` 必须跟着 `firstSeq` 一起走——那句「前面还有没有」问的是**这一条**之前。
 * 拆开取会配出一对互相矛盾的值。
 *
 * `loading` 只有翻页那一方说了算（它是唯一会把按钮置灰的人），别人不传就保持原样。
 */
import type { ChatPage } from '../protocol/events.ts'

export function mergeChatPage(cur: ChatPage | undefined, next: ChatPage): ChatPage {
  const c = cur || {}
  const known = typeof c.firstSeq === 'number' ? c.firstSeq : null
  const first = typeof next.firstSeq === 'number' ? next.firstSeq : null
  // 带来了更早的游标就是它赢；一条游标都没带（空会话、续传）时，只有在我们本来也
  // 什么都不知道的情况下才认它那句 hasMore。
  const wins = first != null ? known == null || first < known : known == null
  return {
    ...c,
    firstSeq: wins && first != null ? first : c.firstSeq,
    hasMore: wins && typeof next.hasMore === 'boolean' ? next.hasMore : c.hasMore,
    loading: next.loading !== undefined ? next.loading : Boolean(c.loading),
  }
}
