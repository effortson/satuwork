/**
 * 名单上那颗点：从事件就地更新摘要。原先是 gateway/ui/chat.js 的 settleDot / noteBotEvent /
 * refreshSum，这里去掉了「改了就重绘」那一下——返回 changed，由宿主决定画不画。
 */
import type { RosterSum, SessionEvent } from '../protocol/events.ts'
import { messageText } from './events.ts'

export function newSum(): RosterSum {
  return { state: 'idle', lastAt: 0, lastText: '' }
}

/**
 * 那颗点现在算哪一态。三样东西合成一个：**在等人 > 正在跑 > 空闲**。
 *
 * 分成三个计数而不是直接写 `sum.state`，是因为它们会交错：点了停止那一下，
 * `agent.abort()` 不等已经开跑的工具（见 bot 的 bridgeTools），`turn/end` 完全可能排在
 * 确认的终态**前面**到达——照着「最后一条事件」写的话，那颗点会从「空闲」被翻回
 * 「正在执行」然后一直停在那儿。各自记数、每次重算，就没有这个先后问题。
 */
export function settleDot(sum: RosterSum): void {
  const waiting = (sum.openIds ? sum.openIds.size : 0) + (sum.snapIds ? sum.snapIds.size : 0)
  const asking = sum.asks ? sum.asks.size : 0
  sum.state = asking || waiting ? 'review' : sum.busy ? 'busy' : 'idle'
  /**
   * **「在等你」还要分得出是哪一种。** 一颗点只说得出「有事」，而这两件事人要做的
   * 动作完全不同：拍板是当场点一下（那一轮真的停在席位上等着，5 分钟就超时按拒绝
   * 收口），接手是领一张能挂几天的单。名单上那个图标照这一格画。
   *
   * 两样都有时报拍板：它有钟在走，另一张单不会因为晚看十分钟就作废。
   */
  sum.need = asking ? 'approval' : waiting ? 'handoff' : ''
}

/** 事件到了就地更新摘要。O(1)，不 fold。返回摘要有没有变（变了宿主才重绘名单）。 */
export function applyRosterEvent(sum: RosterSum, ev: SessionEvent): boolean {
  const before = sum.state + '|' + sum.lastAt + '|' + sum.lastText
  if (ev.type === 'turn/start') {
    sum.busy = true
    settleDot(sum)
  } else if (ev.type === 'turn/end') {
    sum.busy = false
    settleDot(sum)
  } else if (ev.type === 'human/handoff') {
    /**
     * **「待人工处理」的第二个数据源。**
     *
     * 确认那一路（下面那条）只在一轮**正在跑**的时候出现，人多半就坐在这一屏。转人工
     * 不是：单子开出来之后那一轮就收口了，会话回到空闲，而这件事可能是半夜的日常任务
     * 开出来的。少了这一条，名单上那颗点会安安静静地写着「空闲」，而那台 Bot 其实卡着
     * 一件等人的事。
     */
    const d = ev.data || {}
    // **按单号记，不是计数。** 同一张单会来好几条（open → claimed → …），加加减减
    // 迟早会漂成一个永远归不了零的数，而那颗点就永远亮着「待人工处理」。
    const set = sum.openIds || (sum.openIds = new Set())
    if (d.state === 'open' || d.state === 'claimed') set.add(d.id)
    else {
      set.delete(d.id)
      // 快照那一份也要销掉，否则这颗点会亮到下一次轮询才灭——而人刚点完交还，
      // 正盯着它看。
      if (sum.snapIds) sum.snapIds.delete(d.id)
    }
    settleDot(sum)
  }
  // 高风险确认会让那次工具调用真的停在席位上等人拍板（policy/approvals.ts），席位为此
  // 发一条 `tool/approval`。名单上那颗点因此有了第三态：不是在跑，也不是跑完了，而是
  // **在等你**——而人多半正在别的 Bot 那一屏，名单是他唯一会瞥到的地方。
  else if (ev.type === 'tool/approval') {
    /**
     * **按 callId 记，不是计数**（同上面 openIds 那条）。加加减减迟早会漂：重放段和实时段
     * 重叠一条 pending 就多加一次，那颗点从此永远亮着「在等你」，人点完了也灭不掉。
     *
     * 终态只删这一条，别的状态不碰——点了停止那一下，`agent.abort()` 不等已经开跑的
     * 工具，`turn/end` 完全可能排在终态**前面**到达；状态由 settleDot 从几个计数现算，
     * 就没有这个先后问题。
     */
    const d = ev.data || {}
    const asks = sum.asks || (sum.asks = new Map())
    if (!d.callId) {
      /* 老日志里可能没有 callId：认不回来的一条宁可不记，也不要记成一个销不掉的。 */
    } else if (d.state === 'pending') {
      asks.set(d.callId, {
        callId: d.callId,
        name: d.name || '',
        reason: d.reason || '',
        at: Number(ev.time) || 0,
        seq: Number(ev.seq) || 0,
      })
    } else asks.delete(d.callId)
    settleDot(sum)
  } else if (ev.type === 'user/message' || ev.type === 'assistant/message') {
    const text = messageText((ev.data || {}).message) || (ev.data || {}).text || ''
    if (text) {
      sum.lastText = text.replace(/\s+/g, ' ').trim().slice(0, 120)
      sum.lastAt = Number(ev.time) || sum.lastAt
    }
  } else if (ev.type === 'assistant/chunk') {
    // 流式期间也把时间往前推，否则「最近回复」会停在上一轮，看着像卡住了。
    sum.lastAt = Number(ev.time) || sum.lastAt
  }
  return before !== sum.state + '|' + sum.lastAt + '|' + sum.lastText
}

/**
 * 从桶里重新认一遍「最近一条消息」。
 *
 * 补历史是往桶的**开头**塞一段，这些事件不能走 applyRosterEvent——那一个是按「刚到的
 * 就是最新的」写的，会把名单上的摘要改成二十轮之前那句话。所以补完历史之后走这里：
 * 从后往前找第一条有正文的消息，**比手上这条新才认**。返回有没有改。
 */
export function refreshSum(sum: RosterSum, events: SessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] || ({} as SessionEvent)
    if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue
    const text = messageText((ev.data || {}).message) || (ev.data || {}).text || ''
    if (!text) continue
    const at = Number(ev.time) || 0
    if (at < sum.lastAt) return false
    sum.lastText = text.replace(/\s+/g, ' ').trim().slice(0, 120)
    sum.lastAt = at || sum.lastAt
    return true
  }
  return false
}
