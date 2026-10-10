/**
 * 本地回显。**发出去的那一刻就画上，不等流把它送回来。**
 *
 * 消息流是单向的：POST 出去，等席位那边把 `user/message` 事件经 SSE 回传，界面才画。
 * Bot 一忙，这中间就是几秒到几十秒的**纯空白**——输入框清空了，屏幕上什么都没多，人
 * 完全看不出自己那一下有没有生效，只好再按一次。
 *
 * 回执一到就撤掉本地这条，换成流里的真货（它带 seq 和服务端时间）。
 *
 * **只认「发出去之后」的那些**：拿 afterSeq 卡住。不卡的话，历史里任何一条同样文字的
 * 消息都会把它抵消掉——发第二遍「好的」时，本地这条会在流还没回来时就凭空消失。
 *
 * 原先是 gateway/ui/chat.js 的 mergePending，它自己去读写 state.chatPending；这里只收
 * **这条会话的**那几条，就地改 folded，返回还没收到回执的那几条，由宿主写回去。
 */
import type { Folded, PendingMessage, UserBlock } from '../protocol/events.ts'
import { splitUploads } from './events.ts'

export function mergePending(folded: Folded, mine: PendingMessage[]): PendingMessage[] {
  if (!mine.length) return []
  const fresh = folded.blocks.filter((b): b is UserBlock => b.kind === 'user' && b.seq != null)
  const left: PendingMessage[] = []
  for (const p of mine) {
    // 比的是 raw（拼好的完整正文），不是显示用的 text——后者已经把附件那段拆走了。
    const hit = fresh.findIndex((b) => (b.seq as number) > p.afterSeq && (b.raw != null ? b.raw : b.text) === p.text)
    if (hit >= 0) fresh.splice(hit, 1)
    else left.push(p)
  }
  if (!left.length) return left
  for (const p of left) {
    // 回执还没回来的那几秒也要长成最终的样子，否则附件会先以一行路径文本出现、
    // 再突然变成药丸——同一条消息在屏幕上跳两次。
    const up = splitUploads(p.text)
    folded.blocks.push({
      kind: 'user',
      text: up.text,
      files: up.files,
      raw: p.text,
      images: p.images || [],
      mentions: p.mentions || [],
      refs: p.refs || [],
      via: folded.channelVia ? 'web' : '',
      time: p.at,
      pending: true,
    })
  }
  // 没回执之前也要有「正在想」：那一行是人按下回车之后唯一的进度反馈。
  if (!folded.status) {
    folded.status = 'sending'
    // 秒表从**按下发送**那一刻起算：回执还没回来的这几秒同样是在等（见 fold 的 statusAt）。
    folded.statusAt = left.reduce((min, p) => (p.at && (!min || p.at < min) ? p.at : min), 0)
  }
  return left
}
