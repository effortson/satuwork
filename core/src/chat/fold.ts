/**
 * 把一串会话事件折成气泡。**一字不改地**从 gateway/ui/chat.js 搬来：这是整套界面里最容易
 * 搬坏的一段（Telegram 来源、空壳工具、压缩落在轮中间、/clear……每一条都有线上事故在
 * 后面），所以只加类型、不动逻辑。e2e 的 chat-fold.mjs 和 ui-smoke 继续经 Web 那层喂它。
 */
import type { Block, Folded, SessionEvent } from '../protocol/events.ts'
import { isShot, messageImages, messageMentions, messageRefs, messageText, splitUploads } from './events.ts'

export function fold(events: SessionEvent[] | null | undefined, live?: boolean | null, channelBot = false): Folded {
  const blocks: Block[] = []
  // 名册标记负责首条 Telegram 消息之前的 Web 轮次；历史里的渠道来源兼容旧响应。
  const showChannelVia = channelBot || (events || []).some((ev) => {
    const source = ev?.type === 'user/message' ? ev?.data?.source : null
    return source?.kind === 'plugin' && source.plugin === 'channel' && source.channel === 'telegram'
  })
  let assistant: any = null
  let tools: any[] = []
  // 同一条主会话可以同时收 Web 和 Telegram；助手回复继承本轮用户消息的来源。
  let turnVia = ''
  let status = ''
  let modelSeq = 0
  /**
   * 正在跑的这一轮是**什么时候开始的**（turn/start 那条事件的时间）。
   *
   * 读秒要的是「我已经等了多久」，那个起点只能是这一轮开始的时刻——不是第一个字
   * 落地的时刻。按后者算，一轮里模型先想十秒再开口，屏幕上的秒表会在第一个字冒出来
   * 的瞬间从头开始数，而人明明已经等了十秒。
   */
  let statusAt = 0
  // 空壳工具调用的 callId（见下面 tool/call）。它们的结果也要一起跳过。
  const phantoms = new Set<string>()
  /**
   * callId → 那颗工具药丸，跨块认。给 `tool/shot` 用：它晚于 `tool/result` 到，中间可能
   * 隔着后面几步，`tools` 这时候未必还是那次调用所在的那一份。
   */
  const toolByCall = new Map<string, any>()
  /** 最后一条 `todo/list` 快照。见下面那一支。 */
  let todos: Folded["todos"] = null
  /** 单号 → 已经画在某一块上的那张交接卡。跨块认，见下面 human/handoff。 */
  const handoffSeen = new Map<string, any>()
  const handoffOf = (id: string) => (id ? handoffSeen.get(id) : undefined)
  for (const ev of events || []) {
    const type = ev.type
    const data: any = ev.data || {}
    // 事件自带 time（bot 那边 append 时打的）。界面上要按天分隔、每条标时刻，
    // 所以 fold 得把它带出来——只有块的**第一条**事件的时间算数，流式续写的那些
    // chunk 不该让一条消息的时间一直往后跳。
    const at = Number(ev.time) || 0
    if (type === 'user/message') {
      /**
       * 不是人打进来的那些一律不画，但外部渠道和明确的代理入口要画。
       *
       * 那一条 `source` 是 `plugin: 'handoff'`（席位替接手的人发的，见 policy/handoff.ts），
       * 但它就是一个人做完事之后说的话，是这一轮的起因。滤掉的话，界面上会看到 Bot
       * 突然自己开口接着干活，而上一句是几小时前它说"等人接手"。
       */
      const src = data.source || {}
      // Telegram / Web 在同一主会话里按 via 分辨；看板、日常任务和交还继续用原来的代理标签。
      const via = src.kind === 'plugin' && src.plugin === 'channel'
        ? (src.channel === 'telegram' ? 'telegram' : String(src.channel || 'channel'))
        : src.kind === 'plugin' && (src.plugin === 'kanban' || src.plugin === 'routine' || src.plugin === 'handoff')
          ? src.plugin
          : (!src.kind || src.kind === 'user') ? (showChannelVia ? 'web' : '') : ''
      if (src.kind && src.kind !== 'user' && !via) continue
      turnVia = via
      assistant = null
      tools = []
      const raw = messageText(data.message) || data.text || ''
      const up = splitUploads(raw)
      blocks.push({
        kind: 'user',
        text: up.text,
        // 附件列表拆出来单独画成药丸；正文只留人真正打的那句话。
        files: up.files,
        // **点名要跟着消息留下来。** 它是这条消息的一部分（决定了这一轮的工具表），
        // 不是输入框上一个发完就没的装饰。丢掉的话翻上去看昨天那条，「@ 了谁」就消失了，
        // 而那正是「它为什么去读了我的邮箱」的唯一答案。
        mentions: messageMentions(data.message),
        // 引用同理：它是这条消息的一部分，翻上去要看得出「当时指的是哪条、哪个文件」。
        refs: messageRefs(data.message),
        // **这行话从哪来。** Web / Telegram / 代理任务都画在气泡上的角标。
        via,
        // **raw 不能省。** mergePending 靠「文字一模一样」认回执，而它手上那份是
        // 拼好的完整正文。只留拆过的 text，带附件的消息就永远认不回来——那条 pending
        // 销不掉，界面会一直挂着「正在思考」。
        raw,
        images: messageImages(data.message),
        time: at,
        seq: ev.seq,
      })
    } else if (type === 'assistant/message') {
      const text = messageText(data.message)
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools, via: turnVia, time: at, seq: ev.seq }
        blocks.push(assistant)
      }
      if (text) assistant.text = text
      /**
       * **引用要指这一条，不是块的 seq。** 块的 seq 是它第一条事件的（常常是一条
       * assistant/chunk 或 tool/call），拿它去引用，席位会说「引用的消息不存在」——它只认
       * user/message 和 assistant/message。一轮里多条助手消息（工具中间穿插的）取最后
       * 一条，和上面 text 的取法一致。
       */
      assistant.msgSeq = ev.seq
      assistant.endTime = at
    } else if (type === 'assistant/chunk') {
      const chunk = data.chunk || {}
      if (chunk.type === 'text-delta' && chunk.text) {
        if (!assistant) {
          assistant = { kind: 'assistant', text: '', tools, via: turnVia, time: at, seq: ev.seq }
          blocks.push(assistant)
        }
        assistant.text += chunk.text
        assistant.endTime = at
      }
    } else if (type === 'tool/call') {
      // 工具常常在助手吐出第一个字**之前**就开始跑（先查订单再回话）。以前只在已经有
      // 助手块时才把工具挂上去，于是这一段时间里工具痕迹无处可去，等回答开始才突然
      // 冒出来——正好是最想知道「它在干什么」的那几秒什么都看不到。这里补一条：工具
      // 一开跑就把助手块建出来，正文留空，界面上就是一个带工具痕迹的「正在想」气泡。
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools, via: turnVia, time: at, seq: ev.seq }
        blocks.push(assistant)
      }
      // **没有名字的不画。** 那是 bot 那边一个已经修掉的下标错位留下的空壳（见
      // llm/gateway.ts 的 toolSlot），它从来没跑过、也跑不起来，pi 一句「找不到叫「」
      // 的工具」就把它判失败了。可**已经写下的日志里还留着**，翻上去看昨天那轮，
      // 每一轮开头都挂一颗红色的「tool · 失败」，点开里面什么都没有。
      // 结果也一起跳过（见下面 tool/result）：不跳的话它会按「第一条还没有结果的」
      // 认过去，把一次成功的调用标成失败。
      if (!String(data.name || '').trim()) {
        phantoms.add(data.callId)
        continue
      }
      // arguments 要留着：工具药丸的悬浮窗全靠它回答「这次到底拿什么跑的」。存的是
      // bot 那边 JSON.stringify 过的原串，展示时再 parse 一次做缩进（见 toolPopBody）。
      const call = {
        callId: data.callId,
        name: data.name,
        args: typeof data.arguments === 'string' ? data.arguments : '',
        result: null,
        failed: false,
      }
      tools.push(call)
      if (data.callId) toolByCall.set(data.callId, call)
      assistant.tools = tools
      assistant.endTime = at
    } else if (type === 'tool/result') {
      if (phantoms.has(data.callId)) continue
      const hit =
        tools.find((x) => x.callId && x.callId === data.callId && x.result == null) ||
        tools.find((x) => x.result == null) ||
        tools[tools.length - 1]
      if (hit) {
        hit.result = data.text || ''
        hit.failed = Boolean(data.failed)
        // 工具自己报出来的产出文件。老日志没有这个字段，也**不去扫 text 猜路径**——
        // 那段文本是写给模型的散文，措辞一改就扫不出来了。
        hit.files = Array.isArray(data.files) ? data.files : null
        // 这次调用**看到**的文件（ls 列的、grep 命中的、read 读的那一个）。正文里
        // 出现的文件名靠它接成能点开的链接——同样是工具报出来的，不是扫文本猜的。
        hit.refs = Array.isArray(data.refs) ? data.refs : null
        // 浏览器工具拍的那张页面截图。老日志把它放在这儿；新日志另来一条 tool/shot（见下）。
        // 两样都没有就是没有——**不去猜**。
        hit.shot = isShot(data.shot) ? data.shot : hit.shot || null
      }
      if (assistant) assistant.endTime = at
    } else if (type === 'tool/shot') {
      /**
       * 工具结果交出去之后才拍完的那张截图（bot 的 ToolResult.pendingShot）。
       *
       * **只按 callId 认，认不到就丢。** 不像 tool/result 那样退回「最后一颗」：
       * 贴错一张图比少一张更坏——人会拿它去判断那一步到底点到了什么。
       */
      const hit = toolByCall.get(data.callId)
      if (hit && isShot(data.shot)) hit.shot = data.shot
    } else if (type === 'agent/task') {
      /**
       * 一次委派（见 docs/delegation.md）。**挂在助手那一块上**，理由和确认卡一字不差：
       * 另起一块会把卡片插进正在跑的这一轮中间，而 `tool/result` 按 callId 认药丸，
       * 认不回去就会把一次成功的调用标成失败。
       *
       * 同一个 id 会来多条（running → 终态），**取最后一条**。读法和 tool/approval、
       * human/handoff 是同一套。
       */
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools, via: turnVia, time: at, seq: ev.seq }
        blocks.push(assistant)
      }
      const list = assistant.tasks || (assistant.tasks = [])
      const prev = list.find((x: any) => x.id === data.id)
      if (prev) Object.assign(prev, data)
      else list.push({ ...data })
      assistant.endTime = at
    } else if (type === 'skill/saved') {
      /**
       * Bot 给自己记下了一条 Skill（docs/skills.md §13）。**挂在助手那一块上**，理由
       * 和委派卡、确认卡一字不差：另起一块会把它插进正在跑的这一轮中间，而
       * `tool/result` 按 callId 认药丸，认不回去就会把一次成功的调用标成失败。
       *
       * 这是员工唯一一次**在事情发生的当下**看见它改了自己——事后去 Skill 页面翻，
       * 那一屏没人会没事去看。
       */
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools, via: turnVia, time: at, seq: ev.seq }
        blocks.push(assistant)
      }
      const notes = assistant.skillNotes || (assistant.skillNotes = [])
      const seen = notes.find((x: any) => x.callId === data.callId)
      if (seen) Object.assign(seen, data)
      else notes.push({ ...data })
      assistant.endTime = at
    } else if (type === 'memory/saved') {
      /**
       * Bot 记下（改掉、删掉）了一条事实（docs/memory.md §9）。**挂在助手那一块上**，
       * 理由和上面那张 Skill 卡一字不差。
       *
       * 比 Skill 那张更要紧一档：一条记忆此后**每一轮**都摆在提示词里影响回答，
       * 而事后去 Bot 设置里翻，那一屏没人会没事去看。
       */
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools, via: turnVia, time: at, seq: ev.seq }
        blocks.push(assistant)
      }
      const mem = assistant.memNotes || (assistant.memNotes = [])
      const had = mem.find((x: any) => x.callId === data.callId)
      if (had) Object.assign(had, data)
      else mem.push({ ...data })
      assistant.endTime = at
    } else if (type === 'tool/approval') {
      /**
       * 高风险确认。**挂在助手那一块上，不另起一块。**
       *
       * 另起一块的话，卡片会插在正在跑的这一轮中间：上面是已经吐出来的正文、下面是
       * 后续的正文，而工具药丸和它的结果分属两块——`tool/result` 按 callId 认药丸，
       * 认不回去就会把一次成功的调用标成失败。挂在块上，位置就在那颗药丸底下，
       * 也正是人要找它的地方。
       */
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools, via: turnVia, time: at, seq: ev.seq }
        blocks.push(assistant)
      }
      const list = assistant.approvals || (assistant.approvals = [])
      const cur = list.find((a: any) => a.callId === data.callId)
      if (cur) {
        // 同一个 callId 会来两条：先 pending，人点了之后再来终态。取最后一条。
        cur.state = data.state || cur.state
        if (data.scope) cur.scope = data.scope
        // 终态那条带的是**最终**那一份（人改过的话就是改后的），覆盖掉起草时那份。
        if (typeof data.arguments === 'string') cur.args = data.arguments
        if (data.form && Array.isArray(data.form.fields)) cur.form = data.form
        if (Array.isArray(data.edited)) cur.edited = data.edited
      } else {
        list.push({
          callId: data.callId,
          name: data.name || '',
          args: typeof data.arguments === 'string' ? data.arguments : '',
          reason: data.reason || '',
          // 这次用哪张卡、卡上哪几格。**席位算好的**，界面照着画（见 policy/forms.ts）。
          form: data.form && Array.isArray(data.form.fields) ? data.form : null,
          edited: Array.isArray(data.edited) ? data.edited : null,
          state: data.state || 'pending',
          expiresAt: Number(data.expiresAt) || 0,
          // 这条 pending 落在日志的第几行。核对现况时拿它跟快照的水位比——
          // **不拿时间比**，那是两台机器各自的钟（见 approvalDead）。
          seq: ev.seq,
        })
      }
      assistant.endTime = at
    } else if (type === 'human/handoff') {
      /**
       * 转人工的交接单（见 docs/handoff.md）。挂在开单那一块上，和确认卡同一个理由。
       *
       * **同一张单会来好几条**（open → claimed → returned → closed），而且后面那几条
       * 常常隔了几小时——中间人多半又跟 Bot 说过话，于是「当前这一块」早就不是开单
       * 那一块了。所以按单号在**整条会话**里认（handoffOf），认回开单时那一条就地改。
       *
       * 只在当前块里找的话，claimed 会被当成一张新单推进新块：同一张单画出两张卡，
       * 上面那张还写着「等人接手」、按钮还能点——点下去换回一句 409，而人在下面那张
       * 卡里写的结论也读不到（取的是第一个匹配的输入框）。
       */
      const seen = handoffOf(data.id)
      if (seen) {
        seen.state = data.state || seen.state
        if (data.claimedBy) seen.claimedBy = data.claimedBy
        if (data.result) seen.result = data.result
        if (data.repeats) seen.repeats = data.repeats
        // **不动任何一块的 endTime**：这条事件属于开单那一块，而它早就收口了；
        // 拿它去推当前块的时间，气泡下面那行会跳到几小时之后。
        continue
      }
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools, via: turnVia, time: at, seq: ev.seq }
        blocks.push(assistant)
      }
      const hs = assistant.handoffs || (assistant.handoffs = [])
      const fresh = {
        id: data.id,
        callId: data.callId || '',
        state: data.state || 'open',
        reason: data.reason || '',
        ask: data.ask || '',
        summary: data.summary || '',
        blocking: data.blocking !== false,
        claimedBy: data.claimedBy || null,
        result: data.result || null,
        repeats: Number(data.repeats) || 0,
        seq: ev.seq,
      }
      hs.push(fresh)
      handoffSeen.set(data.id, fresh)
      assistant.endTime = at
    } else if (type === 'session/compact' || type === 'session/reset') {
      /**
       * 上下文边界。画成一条横穿的分割线，不是气泡。
       *
       * 自动压缩画的是同一条线，这是顺带修好的一件事：在这之前自动压缩在界面上完全
       * 不可见，人只看到 Bot 从某一刻起开始忘事，没有任何解释。
       *
       * **这里绝不能顺手 `assistant = null; tools = []`。**
       *
       * 直觉上该断：不断的话下一条助手消息会续写到分割线之前那一块上。但那个担心是空的
       * ——两轮之间紧跟着边界的必然是 `user/message`，而那一支自己就会断（见上面）。
       *
       * 而断了会咬人：压缩事件**完全可能落在一个正在跑的轮次中间**（轮末那次是
       * `void maybeCompact`，不 await，还要跑一次摘要模型调用，几秒到十几秒；这期间人
       * 早就发了下一句、下一轮的工具也开跑了）。这时把 `tools` 换成新的空数组，该轮后
       * 到的 `tool/result` 三次 find 全落空、结果被丢掉，而那颗药丸挂在上一块里、
       * `result` 永远是 null——界面上就是一颗**永远停在「调用中」的工具药丸**，刷新也
       * 回不来（重放同一串事件，结果一样）。同一个原因还会把正在流式输出的回答从中间
       * 劈成两个气泡。
       *
       * 不断的话，落在轮中间时这条线就画在那一块的后面，位置诚实，别的什么都不影响。
       */
      /**
       * `/clear`：之前画出来的全部扔掉，只剩这条线（docs/chat-commands.md §15）。
       *
       * 席位那头已经不再给清除点之前的事件了（historySlice），这里管的是**正开着的这一页**：
       * 手上的事件桶里还躺着之前那些，不扔的话点完 `/clear` 屏幕上纹丝不动。
       *
       * 这一支可以断 assistant / tools——和上面那条「绝不能断」不矛盾：`/clear` 只在没在跑
       * 时才收（席位那道闸），不会落在一轮中间。留着它们反倒会让一条迟到的 chunk 续写进
       * 一个已经不在 blocks 里的块，凭空丢字。
       */
      if (type === 'session/reset' && data.clear) {
        blocks.length = 0
        assistant = null
        tools = []
        todos = null
        toolByCall.clear()
        handoffSeen.clear()
      }
      blocks.push({
        kind: 'mark',
        mark: type === 'session/reset' ? (data.clear ? 'clear' : 'reset') : 'compact',
        // 老日志没有 by（那时只有自动压缩），按 auto 读。
        by: data.by || (type === 'session/reset' ? 'user' : 'auto'),
        from: Number(data.from) || 0,
        to: Number(data.to) || 0,
        tokensBefore: Number(data.tokensBefore) || 0,
        tokensAfter: Number(data.tokensAfter) || 0,
        dropped: Number(data.droppedMessages) || 0,
        time: at,
        seq: ev.seq,
      })
    } else if (type === 'session/model') {
      /**
       * 换日常模型（对话框里的选择器、`/model`、或者选的那个被下架了席位自己退回默认）。
       * 同上面那条边界一样画成分割线，不打断正在拼的那一块：换模型也可能落在一轮中间
       * （跑着的时候照样收，下一轮起生效），理由和压缩那条一字不差。
       */
      modelSeq = Number(ev.seq) || modelSeq
      blocks.push({
        kind: 'mark',
        mark: 'model',
        key: data.key || null,
        label: String(data.label || data.key || ''),
        reason: data.reason || '',
        from: String(data.from || ''),
        time: at,
        seq: ev.seq,
      })
    } else if (type === 'todo/list') {
      /**
       * 待办清单的一张全量快照。**不画进消息流**——它是一份状态，不是一句话；每改一次
       * 就在对话里推一条的话，一次十步的活会把人真正在读的内容挤没。折出来给 dock 用。
       *
       * 后一条盖前一条，seq 一起带上：dock 还有第二个数据源（打开这一页时拉的那次快照），
       * 两边谁新按**日志行号**比，不按时间比（理由见 approvalDead）。
       */
      todos = { items: Array.isArray(data.items) ? data.items : [], seq: ev.seq }
    } else if (type === 'turn/start') {
      status = 'running'
      statusAt = at
    } else if (type === 'turn/end') {
      status = ''
      /**
       * **起点也要跟着清掉。**
       *
       * `status` 还有第二个来源：席位的 live 旗子会整个盖掉这里扫出来的结论（见下面
       * 那一句）。留着上一轮的起点，「live 说在跑、而手上这段事件的最后一条是
       * turn/end」时，秒表就从上一轮开始数——早上跑完一轮、晚上那条日常任务起来的
       * 那一帧，气泡下面直接是个「720:00」。清成 0，兜底那句才接得住。
       */
      statusAt = 0
      // **这一轮真正收口的时刻。** 气泡下面那个时间要的是「输出完毕」而不是「开始
      // 输出」，靠的就是它：比最后一条 chunk 准，也覆盖「只调工具、一个字没吐」的
      // 那种轮次（那种轮里根本没有 chunk 可以取时间）。
      if (assistant) assistant.endTime = at
    }
  }
  // bot 说过话就听它的：这份历史可能是截断的，而扫描对截断毫无抵抗力（见 chatLive）。
  if (typeof live === 'boolean') status = live ? 'running' : ''
  /**
   * 席位说「在跑」，可这段历史里根本没有那条 turn/start（截断了，或者只垫了一轮）。
   * 退到手上最后一条事件的时间：秒表会少数一截，但**它至少在走**——而 0 会让这一行
   * 整个消失（见 paintRowTime）。
   */
  if (status && !statusAt) {
    const tail: any = blocks[blocks.length - 1]
    statusAt = (tail && (tail.endTime || tail.time)) || 0
  }
  // modelSeq：最后一条 session/model 的 seq。选择器拿它判「快照旧了没有」，fold 本来就
  // 逐条走一遍，顺手记下，省得每一帧再从头扫一遍事件。
  return { blocks, status, statusAt, todos, channelVia: showChannelVia, modelSeq }
}
