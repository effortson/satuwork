/** 对话的两条实时通道：名单那一条（所有 Bot 的点和摘要），和每个 Bot 的对话流（重连、退避、脉搏、重放闸）。原先在 chat.js 里，拆出来只是搬家（顺序见 index.html）。 */
/* ══ 名单那一条实时通道 ═══════════════════════════════════════════════
   侧栏名单要的是每个 Bot「在不在跑 / 最近说了什么 / 是不是在等你」。这三样以前是
   **一个 Bot 一条 SSE** 拿回来的，两笔代价都很重：

     · 连接槽——HTTP/1.1 下浏览器每个源只给 6 条，而 SSE 是永不结束的 fetch，开着就
       占死一条。十几个 Bot 直接把槽占光，画出正文的那条 history 排在后面干等。
     · token 洪流——那几条流拿的是**全量**事件，包括每个 token 一条的 chunk。十个 Bot
       同时干活就是十路 token 流在主线程上 JSON.parse，画的是侧栏十行灰字。

   现在换成 Gateway 扇入、浏览器只连一条（见 gateway/src/lib/roster-stream.ts）：加上
   正在看的那条对话，**稳定态一共两条连接，跟 Bot 数无关**。

   **它喂的是摘要，不是正文。** 帧里的事件是过滤过的（只有名单消费的那六种），凑不成
   一条完整的会话——所以只喂 noteBotEvent，**绝不进事件桶**：进了的话点进那个 Bot 会
   看到一段缺了正文的历史。正文照旧由 ensureChatSession 在人点进去时另开一条。
   ══════════════════════════════════════════════════════════════════ */

const ROSTER_BACKOFF = SatuCore.ROSTER_BACKOFF
let rosterAbort = null
let rosterTimer = null
/**
 * 名单流**只直连席位机器**（`state.rosterStreamUrl`，理由和对话那条一样，见 directStreamBase）。
 *
 * Gateway 上已经没有 `/runtime/roster/stream` 这条反代了——它是小时级的连接，Gateway 要
 * 变成无状态的就留不得它。所以地址是空的（机器没配 directUrl、或者管家太旧）就**不连**，
 * 也不排重试：地址不会自己长出来，它随下一次 /runtime/bots 到（见 syncRosterStream）。
 * 直连上的失败一律在同一个地址上退避重来——没有别的路可退了。
 */
function directRosterUrl() {
  return state.rosterStreamUrl || ''
}
/** 正在跑的那条流用的地址。/runtime/bots 换了地址时靠它判断要不要重开（见 syncRosterStream）。 */
let rosterLiveUrl = ''

async function startRosterStream(attempt = 0) {
  // 已经有一条在跑就别再开。整页重绘、切页、切 Bot 都会走到这儿。
  if (attempt === 0 && rosterAbort) return
  clearTimeout(rosterTimer)
  const url = directRosterUrl()
  if (!url) {
    rosterAbort = null
    rosterLiveUrl = ''
    return
  }
  const ac = new AbortController()
  rosterAbort = ac
  desktopNoticeRosterReady.clear()
  rosterLiveUrl = url
  const t = token()
  let res
  try {
    res = await swFetch(url, {
      headers: { accept: 'text/event-stream', ...(t ? { authorization: 'Bearer ' + t } : {}) },
      signal: ac.signal,
    })
  } catch {
    if (ac.signal.aborted) {
      if (rosterAbort === ac) rosterAbort = null
      return
    }
    return retryRosterStream(ac, attempt + 1)
  }
  /**
   * 401 / 403 当场认输：票没了、或者这个账号根本没有席位（owner）。重试只会白敲。
   * 404 也在内（管家太旧，还没有这条路由）——Gateway 只在管家够新时才给这个地址，
   * 真出现了说明两头对不上号，重试同样没有意义；下一次 /runtime/bots 会重新判一遍。
   */
  const kind = SatuCore.classifyStreamStatus(res.status, !!res.body)
  if (kind === 'dead') {
    if (rosterAbort === ac) rosterAbort = null
    return
  }
  if (kind === 'warming') return retryRosterStream(ac, attempt + 1)
  /**
   * 下一次重连用哪个档位，判据是**这次连接活了多久**，不是「有没有连上」——和
   * startChatStream 那套一字不差（见 core 的 aliveLongEnough）。不这么算的话，早期
   * 几次失败把档位推到顶之后，哪怕这条流健康地跑了几小时再断，下一次也要等满 30 秒
   * 才重连，而那半分钟里名单上每一颗点都是冻着的。
   */
  const openedAt = Date.now()
  const nextAttempt = () => (SatuCore.aliveLongEnough(openedAt) ? 0 : attempt + 1)
  try {
    for await (const ev of sseEvents(res.body.getReader(), () => ac.signal.aborted || rosterAbort !== ac)) {
      // 中止是在 read() 里等着的时候发生的：那一刻已经在路上的这一块数据照样会到，
      // 而它属于一条作废的流。不在这儿再判一次，它就会写进一份不该再动的名单。
      if (ac.signal.aborted || rosterAbort !== ac) break
      try {
        noteRosterFrame(ev)
      } catch {
        /* 不认识的形状：跳过，别把整条流带下去 */
      }
    }
  } catch {
    if (ac.signal.aborted) {
      if (rosterAbort === ac) rosterAbort = null
      return
    }
  }
  if (ac.signal.aborted || rosterAbort !== ac) return
  return retryRosterStream(ac, nextAttempt())
}

/**
 * 断了自己接回来，**而且不认输**。
 *
 * 认输的代价在这条通道上特别隐蔽：名单上那颗点会停在断掉那一刻的样子——「正在执行」
 * 一直转下去，而那台 Bot 可能十分钟前就干完了。没有任何东西会来纠正它，人也不会想到
 * 去刷新（他看到的是「在跑」，不是「断了」）。所以退避到 30 秒一档之后就一直重试。
 */
function retryRosterStream(ac, attempt) {
  if (rosterAbort !== ac) return
  rosterAbort = null
  const wait = SatuCore.rosterRetryDelay(attempt)
  clearTimeout(rosterTimer)
  rosterTimer = setTimeout(() => void startRosterStream(attempt), wait)
}

/**
 * /runtime/bots 刚把名单流地址带回来：空 → 有值就起流，换了地址就在新地址上重开。
 * 地址没变什么都不动——正在退避的那条留着，别把它的档位打乱。
 */
function syncRosterStream() {
  const url = directRosterUrl()
  if (rosterAbort && rosterLiveUrl !== url) stopRosterStream()
  if (url) void startRosterStream()
}

function stopRosterStream() {
  clearTimeout(rosterTimer)
  rosterLiveUrl = ''
  const ac = rosterAbort
  rosterAbort = null
  if (ac) {
    try {
      ac.abort()
    } catch {}
  }
}

/** 名单通道的一帧。形状见 gateway/src/lib/roster-stream.ts。 */
function noteRosterFrame(msg) {
  if (!msg || typeof msg !== 'object' || !msg.botId) return
  if (msg.type === 'roster/ev') {
    void notifyDesktopEvent(msg.botId, msg.ev, msg.replay === true || (msg.replay !== false && !desktopNoticeRosterReady.has(msg.botId)), msg.sessionId || '')
    // **只更新摘要，不进事件桶**（见这一段开头）。botStreamOf 顺手把这一行建出来：
    // 没有它 noteBotEvent 会直接 return，而刷新之后每一行本来都还没建。
    botStreamOf(msg.botId)
    noteBotEvent(msg.botId, msg.ev || {})
    return
  }
  if (msg.type === 'roster/live' && typeof msg.live === 'boolean') {
    desktopNoticeRosterReady.add(msg.botId)
    /**
     * 席位表的态，压过按事件扫出来的结论——和正文那边 chatLive 治的是同一个病：
     * 席位崩在半路时日志里有 turn/start 没 turn/end，只扫事件的话那颗点永远转下去。
     *
     * **改 busy 再让 settleDot 去算，不直接写 state**：那是派生量，还要把「等审批 /
     * 等接手」一起算进去（见 settleDot）。
     */
    const sum = botStreamOf(msg.botId).sum
    sum.busy = msg.live
    settleDot(sum)
    scheduleRosterPaint()
  }
}

/**
 * 事件流游标。断线重连时带上它，服务端从这一条之后继续发（见 core/src/chat/events.ts 的 cursorOf）。
 */
function chatCursor(botId) {
  return SatuCore.cursorOf(botId ? botStreamOf(botId).events : state.chatEvents)
}

/** 这条会话归哪个 Bot。事件回来时要知道记到谁头上。 */
function botIdOfSession(sessionId) {
  for (const [id, row] of botStreams) if (row.sessionId === sessionId) return id
  return ''
}

const CHAT_RETRY_MAX = SatuCore.CHAT_RETRY_MAX

/**
 * 对话流**只直连席位机器**。
 *
 * 机器配了公网地址、管家够新（≥5 号）时，Gateway 在 `bot.runtime.streamUrl` 里给一个
 * 前缀，这条 SSE 就直接打那台机器，带的还是登录票，管家那头验完换成席位票。它是整套
 * 界面里唯一一条小时级的连接，Gateway 要变成无状态的，头一个就得把它挪走
 * （docs/adr-gateway-vercel-neon.md §7 第 2 步）——所以 Gateway 上
 * `/runtime/sessions/:id/events` 那条反代已经**没有了**，直连不是「优先走」，是唯一一条路。
 *
 * 三种 Bot 三种走法：
 *
 * · **本地 Bot**（壳子里跑在这台 Mac 上的）照旧拼 `/runtime/sessions/<id>/events` 这个
 *   形状——data.js 的 localRoute 认这个形状，改道到 127.0.0.1，压根不碰 Gateway。
 * · **远程 Bot、有 streamUrl**：直接打那台机器。这一跳上的失败按老规矩分两类处置
 *   （见下面 503 和 401/403/404 两段），退避也在同一个地址上——没有别的路可退了。
 * · **远程 Bot、streamUrl 是 null**（机器没配 directUrl、或者管家太旧）：**一个请求都不
 *   发**，当场把原因摆到横幅上。这不是故障，是配置缺一项，重试只会白敲；等哪次
 *   /runtime/bots 把地址带回来，reviveDirectChatStream 会补开这条流。
 *
 * 名单上查不到这颗 Bot、或者名单没带 runtime（低层直接调用、测试）时按本地那个形状走：
 * 不是本地 Bot 的话 Gateway 会回 404，落到「答案不会变」那一支，界面上照样有话。
 */
const NO_DIRECT_STREAM_MSG = '这台机器没有配直连地址（或管家太旧），对话流开不了；找管理员在「机器」页填上 directUrl'

function runtimeBotOf(owner) {
  return owner ? (state.runtimeBots || []).find((b) => b.id === owner) || null : null
}

/** 这颗 Bot 是不是本地 Bot。两个字段都认：名单行上的 runtimeKind，和 overlayLocalRuntime 写的 runtime.kind。 */
function isLocalRuntimeBot(bot) {
  return Boolean(bot && (bot.runtimeKind === 'local' || (bot.runtime && bot.runtime.kind === 'local')))
}

/** 远程 Bot 的直连前缀；本地 Bot、没配地址、名单上没有这颗 Bot 都返回空串。 */
function directStreamBase(owner) {
  const bot = runtimeBotOf(owner)
  if (!bot || isLocalRuntimeBot(bot)) return ''
  return (bot.runtime && bot.runtime.streamUrl) || ''
}

/**
 * /runtime/bots 刷新过后：人正看着的那条会话没有流在跑、而这颗 Bot 现在有直连地址了
 * ——多半是上一次开流时地址还是 null（见 startChatStream 里 NO_DIRECT_STREAM_MSG 那一支），
 * 现在补开。正在退避的流手上还攥着 ac，chatStreamAlive 认它活着，这里不会插队。
 */
function reviveDirectChatStream() {
  const botId = state.chatBotId
  const sessionId = state.chatSessionId
  if (!botId || !sessionId || chatStreamAlive(sessionId, botId)) return
  const row = botStreams.get(botId)
  if (!row || row.sessionId !== sessionId) return
  if (!directStreamBase(botId)) {
    // 还是没有地址：把那句话写回去。loadRuntimeBots 开头把 runtimeError 清了，不写回的话
    // 下一次重绘横幅就没了，而这条流其实一直没开过。
    const bot = runtimeBotOf(botId)
    if (bot && bot.runtime && !isLocalRuntimeBot(bot)) state.runtimeError = NO_DIRECT_STREAM_MSG
    return
  }
  void startChatStream(sessionId, 0, botId)
}

async function startChatStream(sessionId, attempt = 0, botId = '') {
  const owner = botId || botIdOfSession(sessionId)
  const isActive = () => state.chatSessionId === sessionId
  if (attempt === 0) {
    const row = owner ? botStreamOf(owner) : null
    // 这条流已经在跑就别再开一条。**换 Bot 不再掐流**：名单要靠它继续报「跑完没有」。
    if (row && row.sessionId === sessionId && row.ac) {
      // 但**必须把它认领成当前那条**，不能只是 return。
      //
      // 它很可能是上一次待在这个 Bot 上时留下的（换 Bot 不掐流），或者是某条重连路径
      // 刚刚接回来的。那会儿它不是当前会话，chatAbort / chatStreamId 都没设。随后
      // ensureChatSession 把 chatSessionId 指
      // 过来，这条流在读循环里就同时满足了「是当前会话」和「chatStreamId 对不上」——那
      // 正是「人已经切走了」的判据，于是它自己收摊；retryChatStream 又拿同一把闩去认它，
      // 一次都不重连。结果就是正文一片空白、名单上没时间没摘要，切走再切回来还是空的
      // （热路径看见 ac 还在，以为流好着呢），只能刷新整页——而刷新之后这场竞态照样掷骰子。
      if (isActive() && chatAbort !== row.ac) {
        chatAbort = row.ac
        chatStreamId = sessionId
      }
      return
    }
    if (isActive()) stopChatStream()
  }
  const ac = new AbortController()
  if (owner) {
    const row = botStreamOf(owner)
    row.sessionId = sessionId
    row.ac = ac
    trimBotStreams(owner)
  }
  // `|| !owner`：没归到哪个 Bot 名下的流（低层直接调用、测试）按老规矩走单流那一套，
  // 否则它既不在 botStreams 里、又不是当前会话，就成了没人认领的孤儿——断了不重连，
  // 也没人把「连接断开」摆到界面上。
  if (isActive() || !owner) {
    chatAbort = ac
    chatStreamId = sessionId
    // 断线重连（带 after）也可能补一大段，同样先拉闸。
    beginReplay()
  }
  const t = token()
  const after = chatCursor(owner)
  // 头一次连（手上还没有事件）才要 tail，而且**只垫一轮**——打开对话要看的那二十轮
  // 走 HTTP（hydrateChat）。续传时 after 说了算，要的是「补上错过的」。
  const q = after != null ? '?after=' + encodeURIComponent(after) : '?tail=' + STREAM_TAIL_TURNS
  const bot = runtimeBotOf(owner)
  const direct = directStreamBase(owner)
  if (bot && bot.runtime && !isLocalRuntimeBot(bot) && !direct) {
    // 远程 Bot 没有直连地址：一个请求都不发（理由见 directStreamBase 上面那段）。收摊的
    // 顺序和 401/403/404 那一支一样——ac 要让出去，否则 chatStreamAlive 会一直当它活着。
    releaseChatStream(ac, owner)
    endReplay()
    noteStreamDown(sessionId, NO_DIRECT_STREAM_MSG)
    return
  }
  const streamUrl = (direct ? direct + '/sessions/' : '/runtime/sessions/') + encodeURIComponent(sessionId) + '/events' + q
  let res
  try {
    res = await swFetch(streamUrl, {
      headers: {
        accept: 'text/event-stream',
        ...(t ? { authorization: 'Bearer ' + t } : {}),
      },
      signal: ac.signal,
    })
  } catch (err) {
    if (ac.signal.aborted) {
      endReplay()
      releaseChatStream(ac, owner)
      return
    }
    endReplay()
    // **连不上要接着退避重试，不能就此认输。** 见下面 503 那条的说明。直连这一跳上
    // 「连不上」还多几种形状——机器的证书不对、CORS 头没到、管家正在换版——对人来说
    // 都是同一件事「还没接上」，处置也一样：退避重来。
    noteStreamWarming(sessionId)
    return retryChatStream(sessionId, ac, attempt + 1)
  }
  /**
   * 503 = 席位此刻不在（管家对席位的 fetch 抛了或没回 2xx，见 manager/src/proxy.ts）。
   * **这是「正在重启」，不是「坏了」**：每一次重新部署、每一次管家换版，都必然有几秒钟
   * 落在这个窗口里。
   *
   * 以前这里直接 return，于是撞上这几秒的那次重连就是最后一次——流断了、也不再重来。
   * 席位一分钟后好端端地回来了，页面却再也接不回去：消息 POST 走的是另一条请求，
   * 照发照跑，回答经 SSE 送出来时没人在听。屏幕上就一直挂着「正在思考」——因为
   * mergePending 手上那条 pending 只能靠 SSE 回来的 user/message 销账（见 mergePending）。
   * bot 日志里那一轮明明写着 completed，这是那个「日志跑完了、网页还转着」的成因。
   *
   * 退避重试到 CHAT_RETRY_MAX 为止（约 5 分钟，够一次换版走完）；真的一直不回来，
   * retryChatStream 会把「连接断开」摆到界面上。
   *
   * 剩下的非 2xx 分两类，处置相反，所以必须分开（判据在 core 的 classifyStreamStatus）。
   *
   * · **401 / 403 / 404 是「答案不会变」**：票过期了、这颗 Bot 不是你的、席位在那台
   *   机器上已经没了。重试只会白敲接口，再拿一句「实例还没上线」把真正的原因盖掉。
   *   当场认输，把席位那句原话摆出来。
   *
   * · **其余（500、502、504、以及 ok 但没有 body 的那种）跟 503 一路**：那是中间这
   *   几跳的临时故障——管家反代不到席位时回的正是 502（见 manager/src/proxy.ts），
   *   而换版那几分钟里它就是这个样子。以前这里一律认输，于是一次 502 和「席位永远
   *   没了」在界面上是同一件事。
   */
  const kind = SatuCore.classifyStreamStatus(res.status, !!res.body)
  if (kind === 'dead') {
    releaseChatStream(ac, owner)
    endReplay()
    // **render，不是 paintChat**（见 noteStreamDown 与 retryChatStream 认输那一处的
    // 长注释）：那句话摆在顶上那条横幅里，而横幅只由 chatPage() 拼。
    noteStreamDown(sessionId, (await res.text().catch(() => '')) || '实例还没上线')
    return
  }
  if (kind === 'warming') {
    endReplay()
    noteStreamWarming(sessionId)
    return retryChatStream(sessionId, ac, attempt + 1)
  }
  const reader = res.body.getReader()
  // 重放卡在半路的看门狗。收到 replay/done 就撤——那之后长时间没动静是正常的。
  let sawDone = false
  let stallTimer = null
  const disarmStall = () => {
    sawDone = true
    clearTimeout(stallTimer)
  }
  const armStall = () => {
    if (sawDone) return
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => {
      if (sawDone || ac.signal.aborted) return
      try {
        ac.abort()
      } catch {}
      // 把这一行的 ac 让出去，否则重连会撞上「已经在跑」的那道闸。
      if (owner) {
        const r = botStreams.get(owner)
        if (r && r.ac === ac) r.ac = null
      }
      void startChatStream(sessionId, 0, owner)
    }, REPLAY_STALL_MS)
  }
  armStall()
  const openedAt = Date.now()
  const decoder = new TextDecoder()
  let buf = ''
  /**
   * 下一次重连用哪个退避档位。
   *
   * 判据是**这次连接活了多久**，不是「有没有连上」。两头都要照顾：
   *
   * - 只看「连上了没有」：bot 在崩溃重启循环里（接受连接后立刻断），每次都拿到 200，
   *   档位每次归零，于是每 500ms 重连一次、永远停不下来，也永远走不到「连接断开」。
   * - 只看「一共重连过几次」：一个开着一整天的标签页，被中间那一跳定期掐断 6 次之后
   *   就再也接不回来了——可每一次它都是连上的。
   *
   * 活够 CHAT_ALIVE_MS 才算一次真连接，归零；没活够就沿用当前档位继续退避（core 的 aliveLongEnough）。
   */
  const nextAttempt = () => (SatuCore.aliveLongEnough(openedAt) ? 0 : attempt)
  /**
   * 这条流已经不是「当前那条」了就收摊。切 Bot 的一瞬间，旧流手上可能还攥着一段
   * 已经收到、还没解析的数据；不拦住的话，它会落进新会话的事件数组里，画出来
   * 就是两个 Bot 的消息串在一起。
   *
   * 判据以 chatStreamId 为准（换 Bot 必经 stopChatStream，它就是那把闩）。
   * chatSessionId 只在**已经认定了某条会话**时才参与——低层直接调 startChatStream
   * 的路径（重连、测试）还没来得及认领，不该被当成「串台」拦掉。
   *
   * **不再因为「不是当前会话」就收摊**：后台那几条流正是名单上时间、摘要和转圈的
   * 唯一来源。只有当前这条要盯 chatStreamId（重连时它会被换掉）。
   *
   * **每块问一次、每个事件前再问一次。** sseEvents 是异步生成器，同一块里的几帧是一个
   * 微任务交一个，中间排着的别的回调可能已经换了 Bot——只在块头问，这一块剩下的帧
   * 照样会落进来。
   */
  const gone = () => ac.signal.aborted || (isActive() && chatStreamId !== sessionId)
  // 分帧走 core 的 sseEvents；这条流多要的两样（脉搏、重放看门狗）经它的 hooks 接上。
  const hooks = {
    onChunk: () => {
      if (gone()) return false
      // 任何字节都算脉搏——`: ping` 不是事件、解析会跳过它，但它证明这条链活着。
      // **看门狗不在这里续命**（见 onBatch）：「这条链活着」和「重放在推进」是
      // 两件事，混成一件的后果写在 REPLAY_STALL_MS 上面。
      notePulse(ac, sessionId, owner)
    },
    // 这一批字节里有真的 data 行，就是重放在推进，把看门狗往后推一格——**只有它给看门狗
    // 续命**，`: ping` 不算。在这一批的事件都处理完之后才调：里面要是有 replay/done，
    // sawDone 已经置位，armStall 自己会空转。
    onBatch: (sawData) => {
      if (sawData) armStall()
    },
  }
  try {
    for await (const ev of sseEvents(reader, undefined, hooks)) {
      if (gone()) break
      if (!ev || typeof ev !== 'object') continue
      /**
       * 席位自报家门：**这是不是上次那个进程**。
       *
       * 换版就是把 bot 换一个进程，而浏览器这头只看得见「流断了」——和网络抖一下
       * 长得一模一样。于是它会拿着换版前的游标续传、接着用手上那些从旧进程攒下来
       * 的状态（正在跑的那一轮、排队的 dock、目录里的工具），而没有任何东西会来
       * 纠正它。席位每条流的第一帧都会说一句自己是谁（见 bot/src/web/index.ts 的
       * runtime/hello），认出换了进程就整条会话重来。
       *
       * **头一次见到不算重启**：那是页面刚开、或者这个 Bot 第一次连上，什么都不用做。
       */
      if (ev.type === 'runtime/hello') {
        const seat = String(ev.instanceId || '')
        const row = owner ? botStreamOf(owner) : null
        const known = row ? row.instanceId : ''
        if (row) row.instanceId = seat
        if (seat && known && known !== seat) {
          // 席位换过进程了。这条流上后面那些事件按新会话处理：先把旧的一律作废
          // （事件桶、摘要、「历史补过了」），再回去重新拿一次会话——会话 id 多半
          // 没变（它在席位的盘上），但**目录、队列、在不在跑全得重新问一遍**，
          // 而且那条 hydrate 也要重跑，否则界面停在换版前那一刻。
          seatRestarted(owner, sessionId)
          /**
           * **当场 `return`，这条流上后面的一帧都不再收。**
           *
           * hello 帧和新流的回放帧常常挤在同一个网络分片里。接着往下收的话，刚被
           * resetBotStream 清空的事件桶会被紧随其后的那些帧立刻填回去，而这时
           * `row.sessionId` 已经被置成空串——等 ensureChatSession 认下新会话时，
           * 那道 `if (row.sessionId && row.sessionId !== sessionId) reset` 因为空串
           * 而不成立，这批本该作废的事件就留在了新会话里，seq 还会把
           * chatCursor/hydrateChat 的合并判据一起带歪。
           */
          disarmStall()
          endReplay()
          return
        }
        continue
      }
      /**
       * 排队的消息有变。**不是会话事件**，不进事件桶——它还没发生，进了桶就会被
       * 当成历史画成气泡。它只画在输入框顶上那一行 dock 里。
       */
      if (ev.type === 'queue/change') {
        chatQueues.set(sessionId, Array.isArray(ev.queued) ? ev.queued : [])
        if (isActive()) paintChatQueue()
        continue
      }
      if (ev.type === 'replay/done') {
        disarmStall()
        // 刷新页面之后 dock 要能原样回来：队列在席位那边，这里只是接住它。
        if (Array.isArray(ev.queued)) {
          chatQueues.set(sessionId, ev.queued)
          if (isActive()) paintChatQueue()
        }
        // bot 明说历史放完了。它不是会话事件，不进事件桶。
        // 顺带说了这条会话此刻在不在跑——这句是权威，压过扫出来的那个结论。
        // 续传（after>0）那次 bot 不给这两个值；流垫的又只有一轮，比 hydrateChat
        // 那二十轮窄。两种情况都由 noteChatPage 挡住，别把已经知道的覆盖掉。
        if (typeof ev.firstSeq === 'number' || typeof ev.hasMore === 'boolean') {
          noteChatPage(sessionId, { firstSeq: ev.firstSeq, hasMore: ev.hasMore })
        }
        if (typeof ev.live === 'boolean') {
          chatLive.set(sessionId, ev.live)
          /**
           * 名单上那颗点也是扫出来的，同样会挂在「正在执行」上下不来。
           *
           * **改 `busy` 再让 settleDot 去算，不能直接写 `state`。** 全场只有这一处
           * 曾经直接写 state，而 state 是派生量：30 秒一次的 applyHandoffSnapshot
           * 会对每一行调 settleDot，按 `busy`/`asking`/openIds 重算一遍。busy 还留
           * 着旧的 true（席位崩在半路，日志里有 turn/start 没 turn/end），那颗点就
           * 在下一次轮询时被翻回「正在执行」，而且再也下不来——正是这面权威旗子要
           * 治的病，换个地方又长了出来。顺带 `review`（等审批/转人工）也不该被这一
           * 下抹掉，交给 settleDot 就都对了。
           */
          if (owner) {
            const sum = botStreamOf(owner).sum
            sum.busy = ev.live
            settleDot(sum)
            scheduleRosterPaint()
          }
        }
        if (isActive()) {
          endReplay()
          // **必须无条件重画。** endReplay 的第一行是「闸已经开过了就 return」，
          // 而重放一段长历史（实测 988 条）必然撞上 4 秒硬上限或 120ms 静默兜底，
          // 闸早就自己开了。于是走到这儿时 endReplay 直接返回——bot 刚给的结论
          // 存进了 chatLive，却一帧都没画出来。而这之后没有任何事件会再来触发重绘
          // （正因为它说的就是「没在跑」），界面就永远停在开闸那一刻的样子：
          // 一个悬着的 turn/start，一句「正在处理」，等多久都不变。
          schedulePaintChat()
        }
        continue
      }
      if (owner) void notifyDesktopEvent(owner, ev, !sawDone, sessionId)
      // bot 表过态之后，这个结论就由实时的 turn 事件接着维护。表态之前不碰它——
      // 那会儿来的是重放的历史，正是不能拿来下结论的那一批。
      if (chatLive.has(sessionId) && (ev.type === 'turn/start' || ev.type === 'turn/end')) {
        chatLive.set(sessionId, ev.type === 'turn/start')
      }
      if (owner) {
        if (!pushBotEvent(owner, ev)) {
          // 重复的——历史那条路已经收过这一条了。不进桶、不改摘要，但它证明流还
          // 活着，重放的静默判定要跟着往后推，否则一段全是重复的重放会让闸提前开。
          if (isActive() && state.chatReplaying) bumpReplayQuiet()
          continue
        }
        noteBotEvent(owner, ev)
      } else if (isActive()) {
        // 没有归属又不是当前会话的流，事件无处可放——**绝不能倒进 chatEvents**，
        // 那正是「切走了，旧流剩下的半截落进新会话」的老毛病。
        state.chatEvents.push(ev)
      }
      if (!isActive()) continue
      // replay/done 之前都是历史，不能因为翻到昨天生成过一个网页就突然弹预览。
      // 只有真正的实时 tool/result 才触发自动打开/刷新。
      if (sawDone) maybeLivePreview(ev)
      // 重放还在继续：把「静默」判定往后推。**但照画**——合并重绘由 rAF 管，
      // 状态由 paintChat 摁着不会说假话（两处都见重放闸那段说明）。以前这里是
      // 「重放期间一帧都不画」，代价是刷新之后最长四秒屏幕上什么都没有。
      if (state.chatReplaying) bumpReplayQuiet()
      schedulePaintChat()
    }
  } catch (err) {
    disarmStall()
    endReplay()
    if (!ac.signal.aborted) return retryChatStream(sessionId, ac, nextAttempt())
    return
  }
  disarmStall()
  endReplay()
  // 正常读到 done 也要重连：SSE 被中间那一跳掐掉时看起来就是干净的流结束。
  if (!ac.signal.aborted) return retryChatStream(sessionId, ac, nextAttempt())
}

function retryChatStream(sessionId, ac, attempt) {
  const owner = botIdOfSession(sessionId)
  const row = owner ? botStreams.get(owner) : null
  // 后台流也要重连——名单上的「跑完没有」全指望它。
  if (row ? row.ac !== ac : chatAbort !== ac || chatStreamId !== sessionId) return
  if (attempt >= CHAT_RETRY_MAX) {
    /**
     * 退避到头了。**但不能就此撒手。**
     *
     * 线上抓到的那一次：席位 22:23:25 重启、22:23:26 就在听了，而浏览器直到 5 分钟后
     * 才连上——中间那几百秒里席位一条连接都没收到。原因是标签页在后台：浏览器把
     * setTimeout 节流到分钟级、久了干脆冻住，退避链要么走得极慢、要么根本不走，等它
     * 醒过来时档位早就到头，于是「认输」，从此再没有任何东西去碰它。人回到这一页，
     * 看到的就是一条死掉的对话——而席位好端端地在那儿。
     *
     * 所以认输之后转成**慢速长跑**：每 CHAT_IDLE_RETRY_MS 试一次，只要这一页还开着就
     * 一直试。代价是每半分钟一个请求（而且只在这条流真的断着时才有），换来的是「席位
     * 回来了，界面自己就接上了」——不必等人想起来刷新。
     */
    releaseChatStream(ac, owner)
    idleRetry(sessionId, owner)
    /**
     * **必须 render()，paintChat() 是不够的。**
     *
     * 这句话和旁边那颗「重新连接」按钮画在顶上那条横幅里，而横幅只在 chatPage() 里
     * 拼一次（见 runtimeDownBanner 的调用处）；paintChat 只重画消息流和输入区那几个
     * 已有节点，横幅一个字都不会变。
     *
     * 而这一刻的处境恰恰是「再也不会有别的东西来触发重绘」——流已经死了，事件不会
     * 再来，tickClocks 只改 .sw-time 的文本。于是屏幕上什么都没有：认输了、没人再
     * 重连、也没有那颗能救回来的按钮，界面就那么静静挂着——正是这次要修的那个症状。
     * retryChatSession 认输那一处走的就是 render()。
     *
     * 整页重绘的代价（输入框被换掉、正打着字的人丢焦点和光标位置，见 paintChatCtx 上
     * 的注释）在这里认了：它一整条流只发生**一次**，而且是在连着五分钟接不上之后；
     * 草稿本身跟着 state.chatDraft 回来，不会丢。而后台那几条流断了不走这一下——
     * 见 noteStreamDown。
     */
    noteStreamDown(sessionId, '连接断开')
    return
  }
  const delay = SatuCore.chatRetryDelay(attempt)
  setTimeout(() => {
    // 判据要和上面那一条一样。后台流不在 chatAbort 名下，拿当前会话那把闩去认它，
    // 它就永远等不到这次重连——名单上的时间和摘要从此停在断线那一刻。
    const r = owner ? botStreams.get(owner) : null
    if (r ? r.ac !== ac : chatAbort !== ac || chatStreamId !== sessionId) return
    void startChatStream(sessionId, attempt + 1, owner)
  }, delay)
}

/**
 * 「这条流断了」摆到界面上。
 *
 * **只有人正看着的那一条有资格占用那条横幅。** 切过 Bot 之后手上会留着前几条对话流
 * （见 BOT_STREAM_MAX），其中任何一条断掉都会走到这里——而它说的是另一个 Bot 的事：屏幕上
 * 那条对话好好的，却被扣上一句「连接断开」，人会去点那颗「重新连接」，重连的也是另一
 * 条流。更实在的代价是**那一下是整页重绘**：正在打字的人当场丢焦点和光标位置，而起因
 * 是他根本没在看的一个 Bot。
 *
 * 留着的那几条断了就安静地放手：名单上那一行照旧由名单通道维护，人点进去时
 * ensureChatSession 会重新拿会话、重新开流。
 */
function noteStreamDown(sessionId, message) {
  if (state.chatSessionId !== sessionId) return
  state.runtimeError = message
  // **人不在对话页上就只记下来，不重绘。** 横幅只由 chatPage() 拼，在别的页上重绘一
  // 次谁也看不到那句话，代价却是把人正在填的表单换掉（切走不掐流，所以这条流完全
  // 可能在人已经翻到「机器」页之后才认输）。他回到对话页时 loadPage 自己会重绘。
  if (isChatPath(state.path)) render()
}

/**
 * 「这条流还在热身，正在退避重连」。同样只对人正看着的那一条说。
 *
 * runtimeDownBanner 把「实例还没上线」挡在界面外（它是常态，不该每次重新部署都弹红
 * 字），所以这一句本身不上屏——但它**会盖掉正摆着的那一句**。名单上那几个 Bot 的流
 * 各自在退避重连，谁都会往这一格里写：当前这条会话刚拿到一句「这颗 Bot 不是你的」，
 * 半秒后就被另一个 Bot 的 503 抹成「实例还没上线」，然后横幅连带着消失，人什么都
 * 看不到了。scope 一道，这一格就只由人正看着的那条会话写。
 */
function noteStreamWarming(sessionId) {
  if (state.chatSessionId !== sessionId) return
  state.runtimeError = '实例还没上线'
  // 同上：不在对话页上就没有可画的（paintChat 找不到 chat-thread 会直接返回，但在那
  // 之前它已经把整份事件 fold 了一遍——长会话上这不便宜，而且每一档退避都来一次）。
  if (isChatPath(state.path)) paintChat()
}

const CHAT_IDLE_RETRY_MS = SatuCore.CHAT_IDLE_RETRY_MS
const idleTimers = new Map()

function idleRetry(sessionId, botId) {
  const key = botId || sessionId
  if (idleTimers.has(key)) return
  const timer = setTimeout(() => {
    idleTimers.delete(key)
    // 这期间已经接上了（发消息、切回前台、点了「重新连接」）就不用再排。
    if (chatStreamAlive(sessionId, botId)) return
    // 会话都没了（换了 Bot、退了登录）也不再追。
    const row = botId ? botStreams.get(botId) : null
    if (botId && (!row || row.sessionId !== sessionId)) return
    /**
     * **从最后一档进去**，不是从头。
     *
     * 从 0 开始的话，每次长跑都会带出一整轮退避（40 次、五分钟、越到后面越密），而这
     * 会儿的处境明明是「已经断很久了」——那是在拿请求去撞一扇多半还关着的门。停在最后
     * 一档：连上就照常跑（活够 10 秒退避档位自己归零，见 nextAttempt），连不上就立刻
     * 再落回这条长跑，节奏稳定在半分钟一次。
     */
    void startChatStream(sessionId, CHAT_RETRY_MAX, botId)
  }, CHAT_IDLE_RETRY_MS)
  idleTimers.set(key, timer)
}

/**
 * 撤掉一根长跑。**只撤指名的那一根**——名单上每个 Bot 各有各的，开一条流不该把别人的
 * 也一并撤了：那些流断着，撤掉就再没有人去接，侧栏那几行从此停在断线那一刻。
 */
function cancelIdleRetry(key) {
  const t = idleTimers.get(key)
  if (!t) return
  clearTimeout(t)
  idleTimers.delete(key)
}

/** 退出登录时全撤：票都清了还在敲上一个人的席位，那就不只是难看了。 */
function cancelIdleRetries() {
  for (const t of idleTimers.values()) clearTimeout(t)
  idleTimers.clear()
}

/**
 * 「会话一直拿不到」的慢速长跑。和 idleRetry 一个节奏、共用一张表（退出登录一并撤）。
 *
 * key 上带前缀：同一个 Bot 可能同时有一根流的长跑和一根会话的长跑，撞 key 会让后排上
 * 的那根被当成「已经排过了」直接扔掉。
 */
function idleSessionRetry(botId) {
  if (!botId) return
  const key = 'session:' + botId
  if (idleTimers.has(key)) return
  const timer = setTimeout(() => {
    idleTimers.delete(key)
    // 期间已经接上了、或者人早切到别的 Bot 去了，就不用再排。
    if (state.chatBotId !== botId || state.chatSessionId) return
    void ensureChatSession(botId).catch(() => {
      // 「答案不会变」的那些（Bot 被删了、没权限）由 ensureChatSession 自己摆到界面上，
      // 这里不再重排：那种情况下长跑就是在白敲接口。
    })
  }, CHAT_IDLE_RETRY_MS)
  idleTimers.set(key, timer)
}

/**
 * 席位换了一个进程：这一路的东西全部作废，从头再问一遍。
 *
 * **不是「重连一下」就完了。** 换版之后那些还留在手上的东西，每一样都会骗人：
 *
 * · 事件桶和摘要——旧进程攒下的，界面停在换版前那一刻；
 * · 「正在跑」——旧进程那一轮已经随它一起没了，日志里连 turn/end 都没写成，
 *   而界面会一直挂着「正在思考」（这正是上一轮修过的那个症状的成因）；
 * · 排队的 dock、目录里的工具——都在席位那边，新进程重新拉过一遍，可能已经不一样了。
 *
 * 所以走 ensureChatSession 那条整路：重新拿会话（id 多半没变，它在席位的盘上，但那
 * 一跳同时会把「实例还没上线」那类状态清干净）、重新 hydrate、重新开流。resetBotStream
 * 把上面那三样一起清掉。
 */
function seatRestarted(botId, sessionId) {
  const row = botId ? botStreams.get(botId) : null
  const seat = row ? row.instanceId : ''
  if (row) {
    resetBotStream(row)
    // resetBotStream 会把 sessionId 之外的都清掉；身份要留着，否则下一条流又会把
    // 「头一次见到」当成重启，白重来一轮。
    row.instanceId = seat
    row.sessionId = ''
  }
  chatLive.delete(sessionId)
  chatQueues.delete(sessionId)
  chatPages.delete(sessionId)
  if (state.chatSessionId === sessionId) {
    state.chatSessionId = ''
    state.chatStatus = ''
    state.chatReplaying = false
  }
  if (!botId) return
  /**
   * **人正看着的那一个才走整路**（ensureChatSession：拿会话 + 补历史 + 开流 + 把
   * 「实例还没上线」那类话清掉）。名单上别的 Bot 换版了只悄悄挂回后台流——走
   * ensureChatSession 的话，它会把「当前 Bot」改成那一个，人正在看的对话会被拽走。
   */
  if (state.chatBotId === botId) {
    void ensureChatSession(botId).catch((err) => {
      // 这一路没有别的调用方接得住它（换版撞上「这颗 Bot 已经被删了」是真会发生的）。
      flash('err', err.message)
      render()
    })
    return
  }
  /**
   * 名单上别的 Bot 换版了：**什么都不用做**。它的状态走名单那条通道（一条管所有
   * Bot），而那条通道自己会断线重连、重连时带 `after` 把缺的补回来。以前这里要单独
   * 给它挂一条后台流，正是「一个 Bot 一条流」那套的尾巴。
   */
}

/** 这条会话此刻有没有人在听。判据和 startChatStream 那道「已经在跑」的闸一致。 */
function chatStreamAlive(sessionId, botId) {
  if (!sessionId) return false
  const row = botId ? botStreams.get(botId) : null
  if (row && row.sessionId === sessionId && row.ac) return true
  return chatStreamId === sessionId && Boolean(chatAbort)
}

/**
 * 心跳静默看门狗：**连接没断、字节也再也不来**的那种半死流，只有它救得回来。
 *
 * 这条链有三跳（浏览器 → Gateway → 管家 → 席位），任何一跳把「断」吞掉——反代的
 * pipe 没收尾、网络半开（NAT 超时、机器断电）——浏览器手上这条流就成了「看着还开
 * 着、永远等不来下一个字节」。而重连、退避、慢速长跑、发消息前的 reviveChatStream、
 * 切回前台那一路，**全都以 `row.ac` 在不在为判据**：半死的流 ac 还在，谁都以为它
 * 好着，于是没有任何东西会去碰它。消息照发照跑，回答经 SSE 送出来时没人在听，
 * 屏幕上那句「正在思考」就一直挂着——这正是修了好几轮都没除根的那个形状：每一轮
 * 修的都是「断了之后接不回来」，而这一种压根**没有断**。
 *
 * 判据是 bot 每 15 秒一条的 `: ping`（见 bot/src/web/index.ts 的心跳）：它不是事件、
 * 解析时直接跳过，但它是字节。任何字节都把脉搏往后推；45 秒（三个心跳）没有任何
 * 字节，就把这条流当死的拆掉重连——带 after 游标，静默期间错过的一起补回来。
 *
 * **只盯收到过字节的流。** 连上了却一个字节都没来的那种归重放看门狗管
 * （REPLAY_STALL_MS，8 秒），这边不掺和——也免得对一条还在建连的流下错结论。
 *
 * 定时器懒起懒收：有流才跑，表空了就停。后台标签页里被节流到分钟级没关系——
 * 晚一点发现死流总好过永远不发现，而回到前台还有 visibilitychange 那一路先补。
 */
const STREAM_SILENT_MS = 45_000
const STREAM_SWEEP_MS = 15_000
/** ac -> { sessionId, owner, at }。at = 最后一个字节到达的时刻。 */
const streamPulse = new Map()
let streamSweepTimer = null

function notePulse(ac, sessionId, owner) {
  const p = streamPulse.get(ac)
  if (p) {
    p.at = Date.now()
    return
  }
  streamPulse.set(ac, { sessionId, owner, at: Date.now() })
  if (streamSweepTimer == null) {
    streamSweepTimer = setInterval(() => sweepSilentStreams(), STREAM_SWEEP_MS)
    // Node 环境（e2e 垫片）下别拽着进程不退出；浏览器里 setInterval 是数字，没有 unref。
    if (streamSweepTimer && typeof streamSweepTimer.unref === 'function') streamSweepTimer.unref()
  }
}

function dropPulse(ac) {
  if (ac) streamPulse.delete(ac)
}

function sweepSilentStreams(now) {
  const t = now || Date.now()
  for (const [ac, p] of streamPulse) {
    const row = p.owner ? botStreams.get(p.owner) : null
    // 已经不是任何人手上的那条了（重连换了 ac、或者早被掐了）：只清账，不动流。
    const held = (row && row.ac === ac) || chatAbort === ac
    if (ac.signal.aborted || !held) {
      streamPulse.delete(ac)
      continue
    }
    if (t - p.at < STREAM_SILENT_MS) continue
    streamPulse.delete(ac)
    // 和重放看门狗同一套拆法：先把这一行的 ac 让出去，否则重连会撞上「已经在跑」的闸。
    try {
      ac.abort()
    } catch {}
    if (row && row.ac === ac) row.ac = null
    void startChatStream(p.sessionId, 0, p.owner)
  }
  if (!streamPulse.size && streamSweepTimer != null) {
    clearInterval(streamSweepTimer)
    streamSweepTimer = null
  }
}

/**
 * 没人在听就当场再开一条。
 *
 * **认输不该是死局。** retryChatStream 退避到头会把 ac 清掉、摆一句「连接断开」——
 * 那之后没有任何东西会再去重连，而这一屏还好端端地开着：消息照发照跑，回答经 SSE
 * 送出来时没人接，屏幕上一直挂着「正在思考」。原先唯一的出路是刷新整页。
 *
 * 三个入口都走这里：发消息之前（人正要用它，这是最该确认的一刻）、标签页回到前台
 * （合盖一小时回来，中间那一跳早把流掐了）、以及那句话里的「重新连接」。
 *
 * 重连带 after 游标（见 chatCursor），断线期间错过的那几条会一起补回来——所以这不是
 * 「从现在开始听」，是真的把断掉的那一段接上。
 */
function reviveChatStream(sessionId, botId) {
  const owner = botId || botIdOfSession(sessionId)
  if (!sessionId || chatStreamAlive(sessionId, owner)) return false
  /**
   * 这句话是上一次认输留下的，现在正要重来，先撤掉。
   *
   * **撤掉要连着 render()。** 它和那颗「重新连接」按钮画在顶上那条横幅里，而横幅只由
   * chatPage() 拼——只清 state 不重绘的话，屏幕上那句「连接断开」会一直挂着，人一边看
   * 着「断了」一边收到新回复。这一下只在「上次认输过、现在正接回来」时发生，罕见到
   * 值得为它付一次整页重绘（正打着字的人会丢焦点，见 paintChatCtx 上的注释）。
   */
  // 人主动把它叫醒了（发消息 / 切回前台 / 点按钮），排着的那根慢速长跑就没用了：
  // 快的这一条接手。留着它只是多一个到点空转的定时器。
  cancelIdleRetry(owner || sessionId)
  if (state.runtimeError === '连接断开') {
    state.runtimeError = ''
    // 同 noteStreamDown：人不在对话页上就没有可撤的横幅，别为它把这一页整块换掉。
    if (isChatPath(state.path)) render()
  }
  void startChatStream(sessionId, 0, owner)
  return true
}

/**
 * 重放闸。
 *
 * 打开一条会话时，SSE 会把**全部历史**从头推一遍，和后续的实时事件走同一个通道。
 * 一条 8 轮的对话就是 789 条事件（其中 706 条是流式 chunk）。以前每收到一条就重绘一
 * 次：每次都要 fold 全量事件、比对整棵 DOM、把最后那段 Markdown 重渲染一遍——O(n²)，
 * 而且屏幕上能看见消息一条条往外冒。
 *
 * 更糟的是**状态是错的**：重放到某轮的 `turn/start` 就显示「正在处理」，要等重放出
 * 配对的 `turn/end` 才消失。实测 789 帧里有 772 帧（98%）挂着「正在处理」，而那期间
 * 什么都没在跑——它说的是几小时前那一轮。
 *
 * 这道闸原来的做法是**重放期间一帧都不画**，历史放完再画一次。它治住了上面两条，
 * 却把「闪错状态」换成了更难受的「一片空白」：闸只在 replay/done 到达、或者静默
 * 120ms、或者 4 秒硬上限时才开，而刷新页面时这条流正在跟别的请求抢连接槽（当年名单上
 * 是一个 Bot 一条流），事件断断续续地来，静默判定一次次被推后——于是整整四秒，屏幕上
 * 什么都没有。
 *
 * 现在两头都要：
 *   · **照画。** rAF 已经把一帧里的若干条合并成一次重绘（见 schedulePaintChat），
 *     O(n²) 那笔账本来就不该由这道闸来还。
 *   · **状态由 paintChat 摁住**：重放期间席位还没表态，一律按「没在跑」，扫描扫出来
 *     的那个中间态一眼都不会露出来。
 *
 * 闸本身留着，它现在只回答「席位表态了没有」这一件事。三个判据照旧：
 *   1. bot 发的 `replay/done`（准确，但要 bot 也升级）
 *   2. 静默 120ms（兜底：重放是连续灌的，一停就是灌完了）
 *   3. 4 秒硬上限，免得某条流一直断续把闸卡死
 */
/**
 * 重放停在半路多久算「卡住了」。
 *
 * bot 把整段历史 enqueue 完就立刻发 `replay/done`，两者在网线上几乎是挨着的。所以
 * 「收着收着没了、而且迟迟等不到 replay/done」只有一种解释：尾巴压在下游某一层的
 * 缓冲里，而一条安静的会话再也不会有新字节把它顶出去。实测就是这样丢了 24 条。
 *
 * 到点就带着游标重连——bot 会把缺的那截补上，`replay/done` 也跟着来。比干等强，
 * 也比整页刷新强：刷新是从 0 再放一遍，缓冲边界照样可能卡在同一个地方。
 *
* **4 秒，而不是原来的 8 秒。**
 *
 * 能缩短，是因为上面那条 sawData 把这道闸的判据修对了：它现在量的是「**重放有没有在
 * 推进**」——只有真事件给它续命，`: ping` 不算。所以「N 秒内一条事件都没来、而
 * replay/done 也没到」就是货真价实的卡住，不必留那么宽的余量。判据没修之前不敢缩：
 * 那会儿它量的是「有没有收到字节」，一次慢一点的重放就会被误杀。
 *
 * **为什么不是反过来、让那条 15 秒的 ping 先去顶。** ping 存在的理由确实是把压在下游
 * 缓冲里的尾巴顶出去（见 bot 的 web/index.ts），闸拉到 20 秒就能等到它。可席位那条
 * `setInterval` 是从开流那一刻起算的，第一条 ping 稳稳落在 15 秒——**比现在这条重连
 * 路径还慢**。线上那份日志里，相隔整 8 秒的那次重连（`tail=1` 之后紧跟一条
 * `after=<游标>`）是**成功**的：补上之后就不再卡了。既然重连本来就管用，就让它快一点。
 *
 * 缩到 4 秒之后，人看到的那段空白从 8 秒变成 4 秒。至于 replay/done 一开始为什么会
 * 丢——那是下游哪一跳在攒帧的问题，得用 gateway/deploy/check-sse.mjs 逐跳打出来，
 * 不在这道闸的职责里。
 */
const REPLAY_STALL_MS = 4000
const REPLAY_QUIET_MS = 120
const REPLAY_MAX_MS = 4000
let replayQuietTimer = null
let replayCapTimer = null

function beginReplay() {
  state.chatReplaying = true
  clearTimeout(replayCapTimer)
  replayCapTimer = setTimeout(() => endReplay(), REPLAY_MAX_MS)
  bumpReplayQuiet()
}

/** 又来一条：重放还在继续，把「静默」判定往后推。 */
function bumpReplayQuiet() {
  if (!state.chatReplaying) return
  clearTimeout(replayQuietTimer)
  replayQuietTimer = setTimeout(() => endReplay(), REPLAY_QUIET_MS)
}

function endReplay() {
  clearTimeout(replayQuietTimer)
  clearTimeout(replayCapTimer)
  if (!state.chatReplaying) return
  state.chatReplaying = false
  paintChat()
}

let chatPaintQueued = false

/**
 * 流式渲染期间合并重绘。
 *
 * 每个 token 都整块 innerHTML 重建一次会话，是 O(n²)：第 n 个 token 要连带重画前面
 * n-1 条消息。一帧一次就够，人眼分辨不出差别，长会话下差别很大。
 */
function schedulePaintChat() {
  if (chatPaintQueued) return
  chatPaintQueued = true
  const run = () => {
    chatPaintQueued = false
    paintChat()
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  else setTimeout(run, 16)
}
