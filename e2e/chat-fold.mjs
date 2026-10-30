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
    svg: () => '',
    api: async () => ({}),
    flash() {},
    render() {},
    initialOf: () => 'X',
    chatBotIdOf: () => 'b',
    fmtTime: (n) => new Date(n).toISOString(),
    document: {
      getElementById: (id) => (id === 'chat-todock' ? todock : null),
      // 记下 document 上挂的监听（长按菜单那几个），测里直接喂假事件。
      addEventListener(type, fn) {
        ;(ctx.docListeners[type] = ctx.docListeners[type] || []).push(fn)
      },
      createElement: () => noNode,
      querySelectorAll: () => [],
    },
    docListeners: {},
    // 长按那几个监听用 instanceof Element 判 target；测里的假元素继承它。
    Element: class Element {},
    matchMedia: () => ({ matches: true }),
    // 顶层挂的那几个监听（resize、keydown）：收下就扔。
    addEventListener() {},
    removeEventListener() {},
  }
  ctx.window = ctx
  ctx.globalThis = ctx
  createContext(ctx)
  // fold 那一组现在住在 core（经 core.js 的 SatuCore 转接回来），所以先把 core.js 装进同一个
  // 上下文——线上它也是 index.html 里第一个脚本。
  runInContext(readFileSync(join(root, 'gateway/ui/core.js'), 'utf8'), ctx, { filename: 'core.js' })
  // 转义和按 SATU_TZ 切天（分割线用）就是 state.js 转接的那几个，直接拿 core 的，不另抄一份。
  ctx.esc = ctx.SatuCore.esc
  ctx.SATU_TZ = ctx.SatuCore.SATU_TZ
  ctx.tzDayKey = ctx.SatuCore.tzDayKey
  runInContext(readFileSync(join(root, 'gateway/ui/ui-kit.js'), 'utf8'), ctx, { filename: 'ui-kit.js' })
  // chat.js 拆成了一串 chat-*.js，按 index.html 里的顺序一个脚本一段地装（和浏览器一样，顶层的
  // 函数声明照旧挂在上下文上）。chat-find.js 是另一件事（对话内查找），这里用不着。
  const html = readFileSync(join(root, 'gateway/ui/index.html'), 'utf8')
  const shards = [...html.matchAll(/<script src="\/(chat(?:-[a-z]+)?\.js)"[^>]*\bdata-app-part\b/g)].map((m) => m[1]).filter((f) => f !== 'chat-find.js')
  for (const f of shards) runInContext(readFileSync(join(root, 'gateway/ui', f), 'utf8'), ctx, { filename: f })
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
  const chatCtx = loadChat(root)
  const { fold, threadRows, rowShell, parseCommand, commandQueryAt, ctxDivText, state } = chatCtx
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

  await test('引用：ref 块折进用户块的 refs，气泡的壳带 seq，流式那条不给「引用」', async () => {
    // docs/chat-references.md §7.3：翻上去要看得出「当时指的是哪条、哪个文件」。
    const quoted = {
      id: 'u6',
      role: 'user',
      content: [
        { type: 'ref', kind: 'message', seq: 4, role: 'assistant', excerpt: '答一', time: T + 4000 },
        { type: 'ref', kind: 'file', path: '报表/二季度.xlsx', name: '二季度.xlsx' },
        { type: 'text', text: '这条按季度重写' },
      ],
    }
    const events = twoTurns().concat([
      ev(6, 'user/message', { message: quoted, source: { kind: 'user' } }),
      ev(7, 'turn/start', { turn: 2 }),
      ev(8, 'assistant/chunk', { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: '改' } }),
    ])
    const folded = fold(events)
    const c = loadChat(root)
    /**
     * 助手块的 seq 是它**第一条**事件的（这里第 1 轮没有 chunk，所以就是 4）；要是先来
     * 一串 chunk 再来 assistant/message，块的 seq 指的就是 chunk。引用必须指
     * assistant/message 那条（msgSeq / quoteSeqOf），否则席位会说「引用的消息不存在」。
     */
    const streamed = fold(
      twoTurns().concat([
        ev(6, 'user/message', { message: um('问二'), source: { kind: 'user' } }),
        ev(7, 'turn/start', { turn: 2 }),
        ev(8, 'assistant/chunk', { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: '答' } }),
        ev(9, 'assistant/message', { turn: 2, step: 1, message: am('答二'), usage }),
        ev(10, 'turn/end', { turn: 2, reason: 'completed' }),
      ]),
    ).blocks
    const a2 = streamed.find((b) => b.kind === 'assistant' && b.text === '答二')
    assert(a2 && a2.seq === 8 && a2.msgSeq === 9, `助手块该 seq=8（第一条 chunk）、msgSeq=9（assistant/message）：${JSON.stringify({ seq: a2?.seq, msgSeq: a2?.msgSeq })}`)
    assert(c.quoteSeqOf(a2) === 9, '引用助手块该指 assistant/message 那条')
    assert(c.rowShell(a2, 'm8').includes('data-seq="9"') && c.rowShell(a2, 'm8').includes('data-key="m8"'), '壳上 data-seq 该是 9、data-key 照旧 m8')
    // 还在流式输出的那块（只有 chunk）：没有可引用的 seq，壳里不画那排动作。
    const live = folded.blocks[folded.blocks.length - 1]
    assert(live.kind === 'assistant' && live.text === '改' && c.quoteSeqOf(live) == null, `流式中的助手块不该能引用：${JSON.stringify(live)}`)
    assert(!c.rowShell(live, 'm-live').includes('chat-ref-msg'), '流式中的助手块壳里不该有「引用」')
    const user = folded.blocks.find((b) => b.kind === 'user' && b.seq === 6)
    assert(user, '没折出那条带引用的用户块')
    assert(user.text === '这条按季度重写', `正文该只剩人打的那句：${JSON.stringify(user.text)}`)
    assert(Array.isArray(user.refs) && user.refs.length === 2, `refs 该有两条：${JSON.stringify(user.refs)}`)
    assert(user.refs[0].kind === 'message' && user.refs[0].seq === 4 && user.refs[0].role === 'assistant' && user.refs[0].excerpt === '答一', `消息引用没认对：${JSON.stringify(user.refs[0])}`)
    assert(user.refs[1].kind === 'file' && user.refs[1].path === '报表/二季度.xlsx' && user.refs[1].name === '二季度.xlsx', `文件引用没认对：${JSON.stringify(user.refs[1])}`)
    // 引用过的文件进名册：正文里再出现它的名字就该能点。
    assert(c.knownFiles(folded.blocks).has('报表/二季度.xlsx'), '引用过的文件没进 knownFiles')
    // 用户块：壳上带 seq（跳回去靠它）和「引用」那颗按钮。
    const shell = c.rowShell(user, 'm6')
    assert(shell.includes('data-seq="6"'), `壳上没带 seq：${shell.slice(0, 200)}`)
    assert(shell.includes('data-act="chat-ref-msg"'), '壳上没有「引用」那颗按钮')
    assert(threadRows(folded, 's1').some((r) => r.kind === 'msg' && r.key === 'm6'), '行的 key 照旧按块的 seq')
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

  await test('主 Bot 派活：目标那边是「派来的任务」，主这边是「任务结果」，两档角标', async () => {
    const events = [
      ev(1, 'session', { version: 5, id: 's1', botId: 'fin', createdAt: T }),
      ev(2, 'user/message', {
        message: um('【主 Bot「助手」派来的任务】\n做月报'),
        source: { kind: 'plugin', plugin: 'task', form: 't1', phase: 'instruction', from: { id: 'main', name: '助手' } },
      }),
      ev(3, 'turn/start', { turn: 1 }),
      ev(4, 'assistant/message', { turn: 1, message: am('月报做好了'), usage }),
      ev(5, 'turn/end', { turn: 1, reason: 'completed' }),
      ev(6, 'user/message', {
        message: um('【任务结果】@财务 做完了（任务：做月报）\n月报做好了'),
        source: { kind: 'plugin', plugin: 'task', form: 't1', phase: 'result', from: { id: 'fin', name: '财务' } },
      }),
      ev(7, 'turn/start', { turn: 2 }),
      ev(8, 'assistant/message', { turn: 2, message: am('收到，我来汇总'), usage }),
      ev(9, 'turn/end', { turn: 2, reason: 'completed' }),
    ]
    const blocks = fold(events).blocks.filter((b) => b.kind === 'user' || b.kind === 'assistant')
    assert(blocks.length === 4, `派来的任务和结果都该画出来：${blocks.length}`)
    assert(blocks.map((b) => b.via).join(',') === 'task,task,task-result,task-result', `角标不对：${blocks.map((b) => b.via)}`)
  })

  await test('直连管家失败：页面地址和管家认的 Gateway 地址不一致时直说该换哪个，一致或桌面端照旧', async () => {
    const say = (origin, protocol, gatewayOrigin) => {
      chatCtx.location = { origin, protocol }
      return chatCtx.directFailText(gatewayOrigin)
    }
    const off = say('http://localhost:3080', 'http:', 'http://192.168.64.1:3080')
    assert(off.includes('http://192.168.64.1:3080') && off.includes('http://localhost:3080'), `不一致时该点出两个地址：${off}`)
    assert(say('http://192.168.64.1:3080', 'http:', 'http://192.168.64.1:3080') === '连不上机器管家', '一致时照旧')
    assert(say('satu://localhost', 'satu:', 'http://192.168.64.1:3080') === '连不上机器管家', '桌面端的源管家另外认，不算不一致')
    assert(say('http://localhost:3080', 'http:', undefined) === '连不上机器管家', '没给 Gateway 源（老 Gateway / 没配公开地址）照旧')
    delete chatCtx.location
  })

  await test('目标那边派来的任务：画成主 Bot 发来的消息（左侧、主 Bot 名字），正文去掉标题和末尾交代', async () => {
    const events = [
      ev(1, 'session', { version: 5, id: 's1', botId: 'fin', createdAt: T }),
      ev(2, 'user/message', {
        message: um('【主 Bot「助手」派来的任务】\n做月报\n\n（做完把结果直接写在回复里，回复会原样交回主 Bot；需要人拍板的事写进结论，不要在这儿等。）'),
        source: { kind: 'plugin', plugin: 'task', form: 't1', phase: 'instruction', from: { id: 'main', name: '助手' } },
      }),
    ]
    const row = threadRows(fold(events), 's1').find((r) => r.kind === 'msg')
    assert(row && row.block.taskFrom && row.block.taskFrom.id === 'main' && row.block.taskFrom.name === '助手', `主 Bot 身份没带出来：${JSON.stringify(row && row.block.taskFrom)}`)
    assert(row.block.text === '做月报', `正文没剥干净：${JSON.stringify(row.block.text)}`)
    const html = rowShell(row.block, row.key)
    assert(html.includes('sw-taskin') && html.includes('data-role="assistant"') && html.includes('>助手<'), `外壳不对：${html}`)
  })

  await test('目标那边派来的活：它那一轮默认折进卡里，状态跟着 turn/end 走，点开才露出过程', async () => {
    const task = { kind: 'plugin', plugin: 'task', form: 't1', phase: 'instruction', from: { id: 'main', name: '助手' } }
    const tc = (callId) => ({ callId, name: 'web_search', arguments: '{}' })
    const events = [
      ev(1, 'session', { version: 5, id: 's1', botId: 'ds', createdAt: T }),
      ev(2, 'user/message', { message: um('【主 Bot「助手」派来的任务】\n搜 6 轮'), source: task }),
      ev(3, 'turn/start', { turn: 1 }),
      ev(4, 'tool/call', { turn: 1, step: 1, ...tc('c1') }),
      ev(5, 'tool/result', { turn: 1, step: 1, callId: 'c1', text: 'ok' }),
      ev(6, 'assistant/message', { turn: 1, step: 1, message: am('第 1 轮搜完'), usage }),
      ev(7, 'turn/end', { turn: 1, reason: 'aborted' }),
      ev(8, 'user/message', { message: um('你好'), source: { kind: 'user' } }),
      ev(9, 'turn/start', { turn: 2 }),
      ev(10, 'assistant/message', { turn: 2, step: 1, message: am('你好！'), usage }),
      ev(11, 'turn/end', { turn: 2, reason: 'completed' }),
    ]
    const folded = fold(events)
    const card = folded.blocks.find((b) => b.kind === 'user' && b.assigned)
    assert(card && card.assigned.state === 'aborted' && card.assigned.turn === 1, `收场状态没记上：${JSON.stringify(card && card.assigned)}`)
    const shut = threadRows(folded, 's1').filter((r) => r.kind === 'msg').map((r) => r.block.text)
    assert(JSON.stringify(shut) === JSON.stringify(['搜 6 轮', '你好', '你好！']), `折着时那一轮的回复不该画出来：${JSON.stringify(shut)}`)
    const head = threadRows(folded, 's1').find((r) => r.kind === 'msg').block
    assert(head.foldable && !head.open && head.calls === 1, `卡片该能开合、数出 1 次工具调用：${JSON.stringify({ foldable: head.foldable, open: head.open, calls: head.calls })}`)
    assert(head.openKey === 's1:2', `开合的键该带上会话：${head.openKey}`)
    runInContext(`taskInOpen.add('s1:2')`, chatCtx)
    const open = threadRows(folded, 's1').filter((r) => r.kind === 'msg').map((r) => r.block.text)
    // 另一颗 Bot 的会话里同一个 seq 的那件不跟着开：每条会话的 seq 都从 1 起。
    const other = threadRows(folded, 's2').filter((r) => r.kind === 'msg').map((r) => r.block.text)
    runInContext(`taskInOpen.clear()`, chatCtx)
    assert(JSON.stringify(open) === JSON.stringify(['搜 6 轮', '第 1 轮搜完', '你好', '你好！']), `点开之后该露出那一轮：${JSON.stringify(open)}`)
    assert(JSON.stringify(other) === JSON.stringify(['搜 6 轮', '你好', '你好！']), `别的会话同一个 seq 不该跟着开：${JSON.stringify(other)}`)
  })

  await test('重放还没收尾时 live 还没到：在跑的派来的活不误报「没收口」', async () => {
    const st = (replaying, live) => {
      state.chatReplaying = replaying
      const out = runInContext(`taskInState(${JSON.stringify({ assigned: { state: 'running' }, live })})`, chatCtx)
      state.chatReplaying = false
      return out
    }
    assert(st(true, false) === 'running', `重放中不该说没收口：${st(true, false)}`)
    assert(st(false, false) === 'lost', '重放完了还没在跑，才是没收口')
    assert(st(false, true) === 'running', '在跑就是在跑')
  })

  await test('派来的活正跑着、卡片折着：不补「正在回答」的空气泡，卡片自己说在跑', async () => {
    const task = { kind: 'plugin', plugin: 'task', form: 't2', phase: 'instruction', from: { id: 'main', name: '助手' } }
    const events = [
      ev(1, 'session', { version: 5, id: 's1', botId: 'ds', createdAt: T }),
      ev(2, 'user/message', { message: um('【主 Bot「助手」派来的任务】\n做月报'), source: task }),
      ev(3, 'turn/start', { turn: 1 }),
    ]
    const folded = fold(events)
    const rows = threadRows(folded, 's1')
    assert(!rows.some((r) => r.key === 'm-live'), `折着的派活不该再补占位：${JSON.stringify(rows.map((r) => r.key))}`)
    const head = rows.find((r) => r.kind === 'msg').block
    assert(head.assigned.state === 'running' && head.live, `该是正在跑：${JSON.stringify(head.assigned)} live=${head.live}`)
  })

  await test('派来的活那一轮在等人批：确认卡不许折进卡里，批完再折回去', async () => {
    const task = { kind: 'plugin', plugin: 'task', form: 't3', phase: 'instruction', from: { id: 'main', name: '助手' } }
    const base = [
      ev(1, 'session', { version: 5, id: 's1', botId: 'ds', createdAt: T }),
      ev(2, 'user/message', { message: um('【主 Bot「助手」派来的任务】\n给客户发封邮件'), source: task }),
      ev(3, 'turn/start', { turn: 1 }),
      ev(4, 'tool/call', { turn: 1, step: 1, callId: 'm1', name: 'send_email', arguments: '{}' }),
      ev(5, 'tool/approval', { turn: 1, callId: 'm1', name: 'send_email', arguments: '{}', state: 'pending', reason: '外发邮件' }),
    ]
    const rows = threadRows(fold(base), 's1').filter((r) => r.kind === 'msg')
    const head = rows[0].block
    assert(head.waits === 1 && head.open, `有没批的确认时该强制摊开：${JSON.stringify({ waits: head.waits, open: head.open })}`)
    const card = rows.find((r) => r.block.kind === 'assistant')
    assert(card && (card.block.approvals || []).some((a) => a.callId === 'm1' && a.state === 'pending'), `确认卡所在的那一块该画出来：${JSON.stringify(rows.map((r) => r.block.kind))}`)
    const done = threadRows(fold([...base, ev(6, 'tool/approval', { turn: 1, callId: 'm1', state: 'approved' })]), 's1').filter((r) => r.kind === 'msg')
    assert(!done[0].block.open && !done[0].block.waits && done.length === 1, `批完该照常折回去：${JSON.stringify(done.map((r) => r.block.kind))}`)
  })

  await test('手机长按：链接、代码、输入框、确认卡、正在选字的那一条交给系统长按；普通正文归我们的菜单', async () => {
    const Base = chatCtx.Element
    const row = new (class extends Base {
      constructor() {
        super()
        this.attrs = {}
      }
      hasAttribute(k) {
        return k in this.attrs
      }
      closest(sel) {
        return sel.includes('.sw-msg') ? this : null
      }
    })()
    /** 假元素：自己是 tag 这种东西，往上是 row。closest 只认「选择器列表里有没有它这个 tag」。 */
    const node = (tag) =>
      new (class extends Base {
        closest(sel) {
          if (sel.includes('#chat-thread .sw-msg')) return row
          if (sel === '#sw-msgmenu') return null
          return sel.split(',').map((x) => x.trim()).includes(tag) ? this : null
        }
      })()
    const menu = (target) => {
      let prevented = false
      for (const fn of chatCtx.docListeners.contextmenu || []) fn({ target, preventDefault: () => (prevented = true) })
      return prevented
    }
    assert(menu(node('span')) === true, '普通正文的系统长按菜单该关掉（长按归我们的菜单）')
    for (const tag of ['a', 'img', 'code', 'pre', 'textarea', 'input', '.sw-approvals']) assert(menu(node(tag)) === false, `${tag} 的系统长按菜单不该被关掉`)
    row.attrs['data-selecting'] = '1'
    assert(menu(node('span')) === false, '点了「选字」的那一条，系统长按要放回来')
    delete row.attrs['data-selecting']
    // 按在链接上：不起我们的长按计时。
    const press = (target) => {
      for (const fn of chatCtx.docListeners.pointerdown || []) fn({ target, pointerType: 'touch', clientX: 1, clientY: 1 })
      const armed = runInContext('pressTimer !== null', chatCtx)
      runInContext('clearTimeout(pressTimer); pressTimer = null', chatCtx)
      return armed
    }
    assert(press(node('span')) === true, '普通正文该起长按计时')
    assert(press(node('a')) === false, '按在链接上不该起我们的长按')
  })

  await test('派活卡的结论包一层 .sw-mdblock：里面的 @某某 才认得出、画得成药丸', async () => {
    const html = runInContext(`taskDetailHtml({ body: '交给 @财务 处理', state: 'done', files: [] }, 'ok')`, chatCtx)
    assert(/class="sw-task-summary sw-md"><div class="sw-mdblock">/.test(html), `结论没包 .sw-mdblock：${html}`)
  })

  await test('混排的点名：正文里留着 @名字，点名带 inline（就地画药丸，不另起一排）', async () => {
    const events = [
      ev(1, 'session', { version: 5, id: 's1', botId: 'b', createdAt: T }),
      ev(2, 'user/message', {
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '打开 ' },
            { type: 'mention', kind: 'connector', id: 'c1', label: 'Gmail (personal)', inline: true, logo: 'https://logos.composio.dev/api/gmail' },
            { type: 'text', text: ' 邮件，让 ' },
            { type: 'mention', kind: 'bot', id: 'b2', label: '客户经理', inline: true },
            { type: 'text', text: ' 处理' },
          ],
        },
        source: { kind: 'user' },
      }),
    ]
    const u = fold(events).blocks.find((b) => b.kind === 'user')
    assert(u.text === '打开 @Gmail (personal) 邮件，让 @客户经理 处理', `正文不对：${u.text}`)
    assert(u.mentions.length === 2 && u.mentions.every((m) => m.inline), `点名要带 inline：${JSON.stringify(u.mentions)}`)
    assert(u.mentions[0].logo === 'https://logos.composio.dev/api/gmail', '存在消息里的图标没带出来')
  })

  await test('主 Bot 派活：任务卡挂在派活那一轮的气泡里，和委派卡一样不断开气泡', async () => {
    const assign = (seq, state, extra = {}) =>
      ev(seq, 'bot/assign', { id: 'c9:mail', callId: 'c9', index: 0, total: 1, bot: { id: 'b-crm', name: '客户经理' }, instruction: '扫邮箱', state, at: T + seq, ...extra })
    const events = [
      ev(1, 'session', { version: 5, id: 's1', botId: 'main', createdAt: T }),
      ev(2, 'user/message', { message: um('让 @客户经理 扫一下邮箱'), source: { kind: 'user' } }),
      ev(3, 'turn/start', { turn: 1 }),
      ev(4, 'assistant/message', { turn: 1, step: 1, message: am('好，派给客户经理。'), usage }),
      ev(5, 'tool/call', { callId: 'c9', name: 'assign_task', arguments: '{}' }),
      assign(6, 'waiting'),
      assign(7, 'running', { taskId: 't1', startedAt: T + 7 }),
      assign(8, 'done', { taskId: 't1', result: '有 1 封要处理', endedAt: T + 8 }),
      ev(9, 'tool/result', { callId: 'c9', text: '派出去的 1 件收场了' }),
      ev(10, 'assistant/message', { turn: 1, step: 2, message: am('客户经理交回来了：有 1 封要处理。'), usage }),
      ev(11, 'turn/end', { turn: 1, reason: 'completed' }),
    ]
    const blocks = fold(events).blocks
    const kinds = blocks.map((b) => b.kind).join(',')
    assert(kinds === 'user,assistant', `块的顺序不对：${kinds}`)
    const a = blocks[1]
    assert(a.text === '客户经理交回来了：有 1 封要处理。', `正文取这一轮最后一条：${a.text}`)
    assert(a.assigns && a.assigns.length === 1, `任务卡没挂到气泡上：${JSON.stringify(a.assigns)}`)
    const task = a.assigns[0]
    assert(task.state === 'done' && task.result === '有 1 封要处理' && task.bot.name === '客户经理', `任务卡取最后一条：${JSON.stringify(task)}`)
    const chip = a.tools.find((x) => x.callId === 'c9')
    assert(chip && chip.result === '派出去的 1 件收场了', 'assign_task 的结果没安回它自己那颗药丸')
  })

  await test('主 Bot 派活被停：不留空气泡，停止落在同一个气泡的任务卡上', async () => {
    const assign = (seq, state, extra = {}) =>
      ev(seq, 'bot/assign', { id: 'c9:mail', callId: 'c9', index: 0, total: 1, bot: { id: 'b-crm', name: '客户经理' }, instruction: '扫邮箱', state, at: T + seq, ...extra })
    const events = [
      ev(1, 'session', { version: 5, id: 's1', botId: 'main', createdAt: T }),
      ev(2, 'user/message', { message: um('让 @客户经理 扫一下邮箱'), source: { kind: 'user' } }),
      ev(3, 'turn/start', { turn: 1 }),
      ev(4, 'tool/call', { callId: 'c9', name: 'assign_task', arguments: '{}' }),
      assign(5, 'running', { taskId: 't1', startedAt: T + 5 }),
      assign(6, 'cancelled', { taskId: 't1', result: '主 Bot 这边停止了。', endedAt: T + 6 }),
      ev(7, 'tool/result', { callId: 'c9', text: '已停止', failed: true }),
      ev(8, 'assistant/message', { turn: 1, step: 2, message: am(''), usage }),
      ev(9, 'turn/end', { turn: 1, reason: 'aborted' }),
    ]
    const blocks = fold(events).blocks
    assert(blocks.map((b) => b.kind).join(',') === 'user,assistant', `块的顺序不对：${blocks.map((b) => b.kind)}`)
    assert(blocks[1].assigns[0].state === 'cancelled' && blocks[1].tools.length === 1, `停止没落在同一块上：${JSON.stringify(blocks[1])}`)
    const rows = threadRows(fold(events), 's1')
    assert(rows.filter((r) => r.kind === 'msg').length === 2, `不该多出空气泡：${rows.map((r) => r.key)}`)
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
