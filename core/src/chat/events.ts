/**
 * 会话事件上的小工具：读消息正文、认附件段、按 seq 插入去重、取游标。原先散在
 * gateway/ui/chat.js 开头；都不碰 state。
 */
import type { Message, Mention, Ref, SessionEvent } from '../protocol/events.ts'

/**
 * 用户消息里的图片块（会话格式 v4 起）。
 *
 * 日志里存的是**路径**不是字节（见 bot 的 session/types.ts），所以这里拿到的也是路径，
 * 要显示还得走一趟预览接口——和点开产出文件是同一条路。
 */
export function messageImages(msg: Message | null | undefined): { path: string; mime: string }[] {
  const content = msg && msg.content
  if (!Array.isArray(content)) return []
  return content.filter((b) => b && b.type === 'image' && b.path).map((b) => ({ path: b.path as string, mime: b.mime || '' }))
}

export function messageText(msg: Message | string | null | undefined): string {
  if (!msg) return ''
  if (typeof msg === 'string') return msg
  const content = msg.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((b) => (b && (b.type === 'text' || b.type === 'reasoning') ? b.text || '' : '')).join('')
}

/**
 * 消息里的 `@` 点名块。
 *
 * 落盘的是结构（`{type:'mention', kind, id, label}`，见 bot 的 session/types.ts），
 * 正文里一个字都没有——`messageText` 也是这么约定的。所以要显示成药丸只能从这里取。
 */
export function messageMentions(msg: Message | null | undefined): Mention[] {
  const content = msg && msg.content
  if (!Array.isArray(content)) return []
  return content.filter((b) => b && b.type === 'mention' && b.label).map((b) => ({ kind: b.kind || 'connector', id: b.id || '', label: String(b.label) }))
}

/**
 * 这条消息引用了什么（`ref` 块，见 docs/chat-references.md）。形状和输入框上那排
 * `state.chatRefs` 一致：发出去前后长得一样。
 */
export function messageRefs(msg: Message | null | undefined): Ref[] {
  const content = msg && msg.content
  if (!Array.isArray(content)) return []
  const out: Ref[] = []
  for (const b of content) {
    if (!b || b.type !== 'ref') continue
    if (b.kind === 'file' && b.path) {
      out.push({ kind: 'file', path: String(b.path), name: String(b.name || b.path.split('/').pop() || b.path) })
    } else if (b.kind === 'message') {
      out.push({
        kind: 'message',
        seq: Number.isFinite(Number(b.seq)) ? Number(b.seq) : null,
        role: b.role === 'user' ? 'user' : 'assistant',
        excerpt: String(b.excerpt || ''),
        time: Number(b.time) || 0,
      })
    }
  }
  return out
}

/**
 * 用户消息开头那段「我上传了文件，在工作区里：」是 Web 的 composeChatBody 自己拼的。
 * 这里把它认回来。
 *
 * **为什么值得认**：不认的话，附件在气泡里就是一行不能点的路径文本，而 Bot 生成的
 * 文件早就是可以点开预览的药丸了——同一个东西，自己传上去的反而看不了，这说不通。
 *
 * 敢按文本认，是因为这段文本**是我们自己生成的**，格式由 composeChatBody 定死；
 * 而且判据卡得很紧：首行必须整句相等（中英两版都列在下面，一条消息可能在另一种
 * 语言下被打开），随后必须是连续的 `- \`uploads/…\`` 行。这和「拿正则去扫模型写的
 * 散文猜路径」是两回事——那种一改措辞就散架，这种不会。
 */
export const UPLOAD_LEADS = ['我上传了文件，在工作区里：', 'I uploaded some files. They are in the workspace at:']

export function splitUploads(text: unknown): { text: string; files: { path: string; name: string }[] } {
  const src = String(text == null ? '' : text)
  const lead = UPLOAD_LEADS.find((x) => src.startsWith(x + '\n'))
  if (!lead) return { text: src, files: [] }
  const lines = src.slice(lead.length + 1).split('\n')
  const files: { path: string; name: string }[] = []
  let i = 0
  for (; i < lines.length; i++) {
    const m = /^- `(uploads\/[^`]+)`$/.exec(lines[i])
    if (!m) break
    files.push({ path: m[1], name: m[1].split('/').pop() || m[1] })
  }
  if (!files.length) return { text: src, files: [] }
  return { text: lines.slice(i).join('\n').trim(), files }
}

/** 一张像样的截图记录：至少有个路径。老日志、坏数据一律当没有。 */
export function isShot(x: any): boolean {
  return Boolean(x && typeof x.path === 'string' && x.path)
}

export function maxSeqOf(events: SessionEvent[] | null | undefined): number {
  let max = 0
  for (const ev of events || []) {
    const seq = Number(ev && ev.seq)
    if (Number.isFinite(seq) && seq > max) max = seq
  }
  return max
}

/**
 * 往桶里插一条事件，**已经有的就不插**。返回它是不是新的。
 *
 * 桶按 seq 有序；但**到达顺序不保证有序**。席位给事件拿号之后才异步落盘、落完才广播，
 * 两次并发 append 完全可能让 seq=42 先于 seq=41 到浏览器。尤其 `todo/list` 正好夹在
 * 工具调用的流式事件之间：把「不比尾巴大」当成「重复」会在新建清单时偶发地把它丢掉，
 * 输入框上面的任务 dock 就一直不出现。
 *
 * 所以这里按 seq **插入并去重**，不是只和尾巴比。桶不大（冷桶另有上限），一次从后往前
 * 找位置的成本远小于让所有 fold 都各自防乱序。
 *
 * 这道闸是给两条路准备的：历史走 HTTP、实时走 SSE，而流上还垫了一轮用来给名单和第一帧
 * 兜底。那一轮和 HTTP 拉回来的最后一轮**必然重叠**——HTTP 先到的话，流的重放段就是一段
 * 桶里全有的事件，照追不误的结果是最后一问一答在屏幕上出现两遍。
 *
 * 反方向由补历史那边的「比头还小才收」挡着。两头都挡上，谁先到就无所谓了。
 *
 * **就地改 `list`，不换数组**：Web 那边 `state.chatEvents` 和某一行的 `events` 是同一个
 * 数组对象，换掉就把别名切断了。
 */
export function insertEvent(list: SessionEvent[], ev: SessionEvent): boolean {
  const seq = Number(ev && ev.seq)
  if (Number.isFinite(seq)) {
    let at = list.length
    for (let i = list.length - 1; i >= 0; i--) {
      const seen = Number(list[i] && list[i].seq)
      if (!Number.isFinite(seen)) continue
      if (seq === seen) return false
      if (seq > seen) {
        at = i + 1
        break
      }
      at = i
    }
    list.splice(at, 0, ev)
    return true
  }
  list.push(ev)
  return true
}

/**
 * 事件流游标。断线重连时带上它，服务端从这一条之后继续发。
 *
 * 事件里的 `seq` 是会话日志的行号，天然单调，所以「续传」就是把最后见到的那个数
 * 回传过去——不需要去重，也不会重放已经画出来的内容。
 */
export function cursorOf(list: SessionEvent[] | null | undefined): number | null {
  if (!list) return null
  for (let i = list.length - 1; i >= 0; i--) {
    const n = Number(list[i] && list[i].seq)
    if (Number.isFinite(n)) return n
  }
  return null
}
