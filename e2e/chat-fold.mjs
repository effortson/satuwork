/**
 * gateway/ui/chat.js 里两组纯函数：把事件折成气泡（fold），以及认斜杠命令
 * （parseCommand / commandQueryAt）。
 *
 * 不起服务、不开浏览器——照 markdown.mjs 那条路，装一层最小垫片在 node 里跑。
 * chat.js 顶层只有两处 `window.addEventListener` 和一堆声明，垫住就能加载。
 *
 * 钉的是两件在真浏览器里**很难复现、复现了也看不出为什么**的事：
 *
 *   1. 上下文边界事件落在一个正在跑的轮次中间（轮末那次自动压缩是 `void`，不 await，
 *      还要跑一次摘要模型调用）。fold 这时要是把 `tools` 换成新数组，该轮后到的
 *      tool/result 就认不回它的药丸——界面上留一颗永远停在「调用中」的药丸。
 *   2. `/etc/hosts` 这种整条就是一个路径的消息，不能被当成「没有这条命令」拦下来。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'

/**
 * 让 chat.js 在 node 里加载起来的最小垫片。
 *
 * fold / 认命令那两组函数一个 DOM API 都不碰；待办 dock 那一块碰的只有
 * `getElementById('chat-todock')` 和那个盒子上的几个属性，所以顺手垫一个假盒子出来
 * ——它是**每次 loadChat 一个新的**，而「重新加载这一页」正是那条规则要认的那一刻。
 */
function loadChat(root) {
  const noNode = { style: {}, setAttribute() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [] }
  const todock = {
    hidden: true,
    innerHTML: '',
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = String(v)
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null
    },
    removeAttribute(k) {
      delete this.attrs[k]
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  const ctx = {
    todock,
    console,
    setTimeout,
    clearTimeout,
    Map,
    Set,
    URL,
    Blob: function Blob() {},
    AbortController: function AbortController() {},
    // chat.js 从别的分片拿的那几个：只留这两组函数真正会走到的。
    state: { chatEvents: [], chatSessionId: 's1', chatPending: [], catalog: [], runtimeBots: [], me: {} },
    t: (s) => s,
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    svg: () => '',
    api: async () => ({}),
    flash() {},
    render() {},
    initialOf: () => 'X',
    chatBotIdOf: () => 'b',
    fmtTime: (n) => new Date(n).toISOString(),
    // 分割线按 SATU_TZ 切天，state.js 里的实现；这里照抄一份。
    SATU_TZ: 'Asia/Kuching',
    tzDayKey: (n) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuching', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(n)),
    document: {
      getElementById: (id) => (id === 'chat-todock' ? todock : null),
      addEventListener() {},
      createElement: () => noNode,
    },
    // 顶层挂的那几个监听（resize、keydown）：收下就扔。
    addEventListener() {},
    removeEventListener() {},
  }
  ctx.window = ctx
  ctx.globalThis = ctx
  createContext(ctx)
  runInContext(readFileSync(join(root, 'gateway/ui/chat.js'), 'utf8'), ctx, { filename: 'chat.js' })
  return ctx
}

const T = Date.parse('2026-08-24T02:00:00Z')
const ev = (seq, type, data) => ({ seq, time: T + seq * 1000, type, data })
const um = (s) => ({ id: 'u' + s, role: 'user', content: [{ type: 'text', text: s }] })
const am = (s) => ({ id: 'a' + s, role: 'assistant', content: [{ type: 'text', text: s }] })
const usage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0 }
const COMPACT = { from: T, to: T + 6000, summary: 's', droppedMessages: 2, tokensBefore: 90500, tokensAfter: 3200 }

/** 一轮完整的问答，第 2 轮带一次工具调用。 */
function twoTurns() {
  return [
    ev(1, 'session', { version: 5, id: 's1', botId: 'b', createdAt: T }),
    ev(2, 'user/message', { message: um('问一'), source: { kind: 'user' } }),
    ev(3, 'turn/start', { turn: 1 }),
    ev(4, 'assistant/message', { turn: 1, step: 1, message: am('答一'), usage }),
    ev(5, 'turn/end', { turn: 1, reason: 'completed' }),
  ]
}

export async function runChatFold({ root, test, assert, log }) {
  const { fold, threadRows, parseCommand, commandQueryAt, ctxDivText, state } = loadChat(root)
  log('\n# chat-fold')

  await test('压缩事件落在轮次中间：工具结果照样认得回它的药丸', async () => {
    /**
     * 时序取自线上会发生的那一种：轮 1 结束 → 轮末 `void maybeCompact` 开跑 → 人立刻
     * 发了下一句 → 轮 2 开跑并调了工具 → 摘要写完，session/compact 落在 tool/call 和
     * tool/result **之间**。
     */
    const events = twoTurns().concat([
      ev(6, 'user/message', { message: um('问二'), source: { kind: 'user' } }),
      ev(7, 'turn/start', { turn: 2 }),
      ev(8, 'tool/call', { turn: 2, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }),
      ev(9, 'session/compact', { throughSeq: 5, ...COMPACT }),
      ev(10, 'tool/result', { turn: 2, step: 1, callId: 'c1', text: '跑完了', failed: false }),
      ev(11, 'assistant/message', { turn: 2, step: 1, message: am('答二'), usage }),
      ev(12, 'turn/end', { turn: 2, reason: 'completed' }),
    ])
    const blocks = fold(events).blocks
    const pills = blocks.flatMap((b) => b.tools || [])
    assert(pills.length === 1, `应有一颗工具药丸，实际 ${pills.length}`)
    // 这一条挂了 = 界面上留一颗永远停在「调用中」的药丸，刷新也回不来。
    assert(pills[0].result === '跑完了', `工具结果没认回药丸：${JSON.stringify(pills[0])}`)
    assert(pills[0].failed === false, '一次成功的调用被标成了失败')
    // 这一轮的工具药丸和这一轮的回答必须还在同一个气泡里——断开的话，边界之后到的
    // 正文会另起一块，屏幕上就是一个空的「正在想」气泡加一段无主的回答。
    const owner = blocks.find((b) => (b.tools || []).some((x) => x.callId === 'c1'))
    assert(owner && owner.text === '答二', `工具药丸和它那一轮的回答被劈到了两个气泡里：${JSON.stringify(owner?.text)}`)
  })

  await test('两轮之间的边界：自己成块，下一轮另起气泡', async () => {
    const events = twoTurns().concat([
      ev(6, 'session/compact', { throughSeq: 5, ...COMPACT }),
      ev(7, 'user/message', { message: um('问二'), source: { kind: 'user' } }),
      ev(8, 'turn/start', { turn: 2 }),
      ev(9, 'assistant/message', { turn: 2, step: 1, message: am('答二'), usage }),
      ev(10, 'turn/end', { turn: 2, reason: 'completed' }),
    ])
    const kinds = fold(events).blocks.map((b) => (b.kind === 'mark' ? 'mark:' + b.mark : b.kind))
    assert(
      JSON.stringify(kinds) === JSON.stringify(['user', 'assistant', 'mark:compact', 'user', 'assistant']),
      `块的顺序不对：${JSON.stringify(kinds)}`,
    )
  })

  await test('Web 和 Telegram 在同一会话中混合，问答都带本轮来源', async () => {
    const events = [
      ev(1, 'session', { version: 5, id: 's1', botId: 'telegram-bot', createdAt: T }),
      ev(2, 'user/message', { message: um('Web 问题'), source: { kind: 'user' } }),
      ev(3, 'turn/start', { turn: 1 }),
      ev(4, 'assistant/message', { turn: 1, message: am('Web 回答'), usage }),
      ev(5, 'turn/end', { turn: 1, reason: 'completed' }),
      ev(6, 'user/message', {
        message: um('Telegram 问题'),
        source: { kind: 'plugin', plugin: 'channel', channel: 'telegram', form: 'update-1' },
      }),
      ev(7, 'turn/start', { turn: 2 }),
      ev(8, 'assistant/message', { turn: 2, message: am('Telegram 回答'), usage }),
      ev(9, 'turn/end', { turn: 2, reason: 'completed' }),
    ]
    const blocks = fold(events).blocks.filter((b) => b.kind === 'user' || b.kind === 'assistant')
    assert(blocks.map((b) => b.text).join('|') === 'Web 问题|Web 回答|Telegram 问题|Telegram 回答', `混合顺序不对：${blocks.map((b) => b.text)}`)
    assert(blocks.map((b) => b.via).join(',') === 'web,web,telegram,telegram', `来源继承不对：${blocks.map((b) => b.via)}`)
  })

  await test('普通 Bot 的 Web 对话不显示 channel 标签', async () => {
    const events = [
      ev(1, 'session', { version: 5, id: 's1', botId: 'ordinary-bot', createdAt: T }),
      ev(2, 'user/message', { message: um('普通问题'), source: { kind: 'user' } }),
      ev(3, 'turn/start', { turn: 1 }),
      ev(4, 'assistant/message', { turn: 1, message: am('普通回答'), usage }),
      ev(5, 'turn/end', { turn: 1, reason: 'completed' }),
    ]
    const blocks = fold(events).blocks.filter((b) => b.kind === 'user' || b.kind === 'assistant')
    assert(blocks.every((b) => !b.via), `普通 Bot 不应有 channel 标签：${blocks.map((b) => b.via)}`)
  })

  await test('分割线走 html 行，不套气泡的壳', async () => {
    const events = twoTurns().concat([ev(6, 'session/reset', { throughSeq: 5, from: T, to: T + 5000, droppedMessages: 2, by: 'user' })])
    state.chatEvents = events
    const row = threadRows(fold(events), 's1').find((r) => r.kind === 'mark')
    assert(row, '没有画出分割线那一行')
    assert(row.html && !('block' in row), '分割线该是 html 行，套 rowShell 会画出一个空壳')
    assert(row.key === 'k6', `key 要跟着事件的 seq 走，实际 ${row.key}`)
  })

  await test('分割线的字：重置说清楚记录还在，自动压缩和手动压缩分得开', async () => {
    const reset = ctxDivText({ kind: 'mark', mark: 'reset', by: 'user' })
    // 「已清空」会让人以为历史没了，而 JSONL 一条没删。
    assert(reset.includes('不再进上下文'), `重置那条话没说清：${reset}`)
    const auto = ctxDivText({ kind: 'mark', mark: 'compact', by: 'auto', tokensBefore: 90500, tokensAfter: 3200 })
    const manual = ctxDivText({ kind: 'mark', mark: 'compact', by: 'user', tokensBefore: 90500, tokensAfter: 3200 })
    assert(auto !== manual, '自动压缩和人点的压缩画出了同一句话')
    assert(auto.includes('自动'), `自动那条该说明是它自己压的：${auto}`)
    assert(manual.includes('90.5k → 3.2k'), `压缩前后的数字没画出来：${manual}`)
    // 老日志没有 tokens 字段——那就不摆一个假的 0 → 0。
    assert(!ctxDivText({ kind: 'mark', mark: 'compact', by: 'auto' }).includes('0'), '老日志缺字段时编了个数字出来')
  })

  await test('/clear：之前画出来的全部扔掉，只剩一条线和之后的消息', async () => {
    const events = twoTurns().concat([
      ev(6, 'session/reset', { throughSeq: 5, from: T, to: T + 5000, droppedMessages: 2, by: 'user', clear: true }),
      ev(7, 'user/message', { message: um('清空之后的问题'), source: { kind: 'user' } }),
      ev(8, 'turn/start', { turn: 3 }),
      ev(9, 'assistant/message', { turn: 3, message: am('清空之后的回答'), usage }),
      ev(10, 'turn/end', { turn: 3, reason: 'completed' }),
    ])
    const blocks = fold(events).blocks
    // 正开着的这一页事件桶里还躺着之前那些：不扔的话点完 /clear 屏幕上纹丝不动。
    assert(blocks[0]?.kind === 'mark' && blocks[0].mark === 'clear', `第一块该是清空那条线：${JSON.stringify(blocks[0])}`)
    const talk = blocks.filter((b) => b.kind === 'user' || b.kind === 'assistant')
    assert(talk.length === 2, `清空之后只该剩 1 问 1 答，实际 ${talk.length} 块`)
    assert(ctxDivText(blocks[0]).includes('已清空'), `清空那条线的字不对：${ctxDivText(blocks[0])}`)
    // 只打 /new 的那条照旧不藏。
    const plain = fold(twoTurns().concat([ev(6, 'session/reset', { throughSeq: 5, from: T, to: T + 5000, droppedMessages: 2, by: 'user' })])).blocks
    assert(plain.filter((b) => b.kind === 'user').length === 1, '/new 把之前的消息也藏起来了')
    assert(parseCommand('/clear')?.cmd?.name === 'clear', '/clear 没认出来')
  })

  await test('认命令：typo 和参数都拦下，路径放行', async () => {
    assert(parseCommand('/compact')?.cmd?.name === 'compact', '/compact 没认出来')
    assert(parseCommand('  /NEW  ')?.cmd?.name === 'new', '大小写和空白该宽容')
    assert(parseCommand('/copmact')?.unknown === '/copmact', 'typo 该被拦下')
    // 拦不住的话，一个手滑的 typo 就发给模型了，它会礼貌地回一段「你是想…吗」，
    // 而人以为自己压缩过了。
    const withArgs = parseCommand('/compact 只留三轮')
    assert(withArgs?.cmd?.name === 'compact' && withArgs.extra, `带参数该单独认出来：${JSON.stringify(withArgs)}`)
    // 整条就是一个路径：命令名里不会有第二个斜杠，这条必须照常当消息发出去。
    assert(parseCommand('/etc/hosts') === null, '/etc/hosts 被当成命令拦下了')
    assert(parseCommand('看下 /compact 是什么') === null, '正文里提到命令不该被拦')
    assert(parseCommand('你好') === null, '普通消息被当成命令了')
  })

  await test('选单只在输入框最开头弹', async () => {
    const q = (v) => commandQueryAt({ value: v, selectionStart: v.length })
    assert(q('/co')?.q === 'co', '开头打 /co 该弹选单')
    assert(q('/')?.q === '', '刚打一个斜杠就该弹')
    assert(q('看下 /compact') === null, '正文中间的斜杠不该弹选单')
    assert(q('/etc/hosts') === null, '路径不该弹选单')
  })

  /**
   * 待办 dock 的可见性（见 docs/todo-tool.md §5）。
   *
   * 钉的是「全部收口了的那张表，重新加载之后不再摆出来」——而它必须只拦那一下：盯着
   * 看的时候最后一条打勾，那一帧还得画出「已完成」，否则人看不见事情收口了。这两句话
   * 在真浏览器里要靠刷新页面才试得出来，而**分辨它们的唯一办法就是分两次 loadChat**。
   */
  const dockOf = () => {
    const c = loadChat(root)
    c.state.chatSessionId = 's1'
    return c
  }
  const listEv = (seq, statuses) =>
    ev(seq, 'todo/list', { callId: 'c1', items: statuses.map((st, i) => ({ id: String(i + 1), task: '事' + (i + 1), status: st })) })

  await test('实时事件乱序：新建任务不会被后到的小 seq 丢掉', async () => {
    const c = dockOf()
    const row = c.botStreamOf('b')
    c.state.chatEvents = row.events
    // 并发落盘时，后拿号的流式事件可能先广播；todo/list 随后才到。
    assert(c.pushBotEvent('b', ev(12, 'assistant/chunk', { turn: 1, step: 1, chunk: '继续' })), '首条事件没进桶')
    assert(c.pushBotEvent('b', listEv(11, ['in_progress', 'pending'])), '后到的 todo/list 被当成重复丢了')
    assert(row.events.map((x) => x.seq).join(',') === '11,12', `事件桶没按 seq 归位：${row.events.map((x) => x.seq)}`)
    c.paintChatTodos(c.fold(row.events))
    assert(!c.todock.hidden && c.todock.innerHTML.includes('事2'), '新建的任务清单没有显示在聊天中')
    assert(!c.pushBotEvent('b', listEv(11, ['pending'])), '同 seq 重放没有去重')
  })

  await test('重新加载：全部收口的清单不再占输入框上面那行', async () => {
    const c = dockOf()
    c.paintChatTodos(c.fold([listEv(4, ['completed', 'completed'])]))
    assert(c.todock.hidden, 'dock 还摆着——它能说的只有一句「昨天那件事做完了」')
    // cancelled 也是收口：做不成、不用做了的标它，不该拿这个把 dock 留在屏幕上。
    const c2 = dockOf()
    c2.paintChatTodos(c2.fold([listEv(4, ['completed', 'cancelled'])]))
    assert(c2.todock.hidden, '全是 completed / cancelled 的表也该收起来')
  })

  await test('重新加载：还有没做完的照常摆出来', async () => {
    const c = dockOf()
    c.paintChatTodos(c.fold([listEv(4, ['completed', 'pending'])]))
    assert(!c.todock.hidden && c.todock.innerHTML.includes('事2'), '还剩一条没做，dock 却收起来了')
  })

  await test('盯着看：最后一条打勾那一帧仍然画出「已完成」', async () => {
    const c = dockOf()
    c.paintChatTodos(c.fold([listEv(4, ['completed', 'in_progress'])]))
    assert(!c.todock.hidden, '还在跑的时候 dock 就不见了')
    c.paintChatTodos(c.fold([listEv(4, ['completed', 'in_progress']), listEv(5, ['completed', 'completed'])]))
    assert(!c.todock.hidden, '最后一条打勾把 dock 抹掉了——人看不见事情收口了')
    assert(c.todock.innerHTML.includes('已完成'), `徽标没换成「已完成」：${c.todock.innerHTML}`)
  })

  await test('收起来之后清单一变，它自己回来', async () => {
    const c = dockOf()
    c.paintChatTodos(c.fold([listEv(4, ['completed', 'completed'])]))
    assert(c.todock.hidden, '第一步就没收起来，后面这一条判不出东西')
    // 模型接着又列了一张新表：指纹变了，和 × 关掉那一张之后的行为必须一模一样。
    c.paintChatTodos(c.fold([listEv(4, ['completed', 'completed']), listEv(9, ['in_progress', 'pending'])]))
    assert(!c.todock.hidden && c.todock.innerHTML.includes('事2'), '新列的一张表没能把 dock 带回来')
  })
}
