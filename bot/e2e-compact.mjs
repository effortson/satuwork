/**
 * 上下文压缩与翻历史。纯函数，不起服务——探针要 tsx 才 import 得了 .ts。
 *
 * 三处最容易错、而且错了都不报错：
 * 1. 压缩边界切在轮次中间 → 助手消息被摘要吃掉、它的 tool/result 留在后面 →
 *    provider 拒收整个请求。这个会报错，但要等到线上才报。
 * 2. 摘要落地之后旧事件还在往模型发，或者摘要本身没进上下文。
 * 3. 时间区间按 UTC 解析。席位在 UTC+8 时，"取昨天" 会整整偏出 8 小时——
 *    取回来的是前天晚上到昨天下午，而且看上去一切正常。
 */
import {
  toAgentMessages,
  compactionPoint,
  scopeAfterBoundary,
  contextBoundary,
  clampTranscript,
  contentDigest,
  observedPromptHighWater,
  compactionWindow,
} from './src/agent/index.ts'
import { parseAt, rowsOf } from './src/tools/history.ts'
import { historySlice } from './src/session/replay.ts'
import { budgetToolText, MODEL_TOOL_RESULT_MAX_CHARS } from './src/tools/result-budget.ts'

let seq = 0
const ev = (type, time, data) => ({ seq: ++seq, time, type, data })
const umsg = (text) => ({ id: 'u' + seq, role: 'user', content: [{ type: 'text', text }] })

const T0 = Date.parse('2026-08-18T02:00:00Z')
const MIN = 60_000

/** n 轮对话，第 k 轮带一次工具调用——工具那轮是边界判断的关键。 */
function conversation(n) {
  seq = 0
  const out = [ev('session', T0, { version: 3, id: 's', createdAt: T0, botId: 'b' })]
  for (let turn = 1; turn <= n; turn++) {
    const t = T0 + turn * 10 * MIN
    out.push(ev('user/message', t, { message: umsg('问题' + turn), source: { kind: 'user' } }))
    out.push(ev('turn/start', t, { turn }))
    if (turn % 3 === 0) {
      out.push(
        ev('assistant/message', t + 1000, {
          turn,
          step: 1,
          message: { id: 'a' + turn, role: 'assistant', content: [{ type: 'tool-call', callId: 'c' + turn, name: 'ls', arguments: '{}' }] },
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0 },
        }),
      )
      out.push(ev('tool/call', t + 1100, { turn, step: 1, callId: 'c' + turn, name: 'ls', arguments: '{}' }))
      out.push(ev('tool/result', t + 1200, { turn, step: 1, callId: 'c' + turn, text: '工具输出' + turn, failed: false }))
    }
    out.push(
      ev('assistant/message', t + 2000, {
        turn,
        step: 2,
        message: { id: 'b' + turn, role: 'assistant', content: [{ type: 'text', text: '回答' + turn }] },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0 },
      }),
    )
    out.push(ev('turn/end', t + 2100, { turn, reason: 'completed' }))
  }
  return out
}

const out = {}

// 1. 边界必须落在 turn/end 上，且两侧各自是完整的轮次
{
  const all = conversation(9)
  const cut = compactionPoint(all, 200)
  const at = all.find((e) => e.seq === cut.seq)
  const kept = all.filter((e) => e.seq > cut.seq)
  // 保留段里每个 tool/result 都必须能在同一段里找到它那一步的助手消息
  const assistantSteps = new Set(
    kept.filter((e) => e.type === 'assistant/message').map((e) => `${e.data.turn}:${e.data.step}`),
  )
  const orphans = kept
    .filter((e) => e.type === 'tool/result')
    .filter((e) => !assistantSteps.has(`${e.data.turn}:${e.data.step}`))
  out.boundary = { type: at?.type, orphanToolResults: orphans.length }
}

// 2. 预算大到装得下全部 → 切在最早的可切点（尽量多留原文）；
//    预算小到什么都装不下 → 切在最靠后的可切点，但仍然留最后一轮
{
  const all = conversation(5)
  const ends = all.filter((e) => e.type === 'turn/end')
  out.budget = {
    roomy: compactionPoint(all, 1e9).seq === ends[0].seq,
    tight: compactionPoint(all, 0).seq === ends[ends.length - 2].seq,
    tooShort: compactionPoint(conversation(1), 100) === undefined,
  }
}

// 3. 有压缩点之后：旧事件不再逐条回传，摘要在最前面
{
  const all = conversation(6)
  const cut = compactionPoint(all, 200)
  const withCompact = [
    ...all,
    ev('session/compact', T0 + 999 * MIN, {
      throughSeq: cut.seq,
      from: T0,
      to: cut.time,
      summary: '前面聊过的要点',
      droppedMessages: 9,
      tokensBefore: 900,
      tokensAfter: 200,
    }),
  ]
  const msgs = await toAgentMessages(withCompact)
  const fullLength = (await toAgentMessages(all)).length
  const texts = msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
  const roles = msgs.map((m) => m.role)
  out.compacted = {
    first: texts[0]?.slice(0, 60),
    hasSummaryBody: texts[0]?.includes('前面聊过的要点') ?? false,
    // 被压掉那几轮的提问不该再出现
    leakedOldQuestion: texts.slice(1).some((t) => t.includes('问题1')),
    keptLatestQuestion: texts.some((t) => t.includes('问题6')),
    shorterThanFull: msgs.length < fullLength,
    // 摘要必须并进保留段第一条用户消息，不能自己占一条——否则前两条都是 user，
    // Anthropic 会以 roles must alternate 拒掉整个请求。
    summaryMergedIntoFirstUser: (texts[0]?.includes('前面聊过的要点') ?? false) && /问题\d/.test(texts[0] ?? ''),
    consecutiveSameRole: roles.some((r, i) => i > 0 && r === roles[i - 1] && r === 'user'),
  }
}

// 3c. 摘要输入超长时掐中间，头部（上一次的摘要）必须活下来
{
  const head = '这是上一次压缩留下的摘要，里面有最早那批事实。'
  const long = head + 'x'.repeat(200_000) + '结尾这段是最近的对话。'
  const clamped = clampTranscript(long)
  out.clamp = {
    keepsHead: clamped.startsWith(head),
    keepsTail: clamped.endsWith('结尾这段是最近的对话。'),
    saysDropped: clamped.includes('中间省略'),
    shrank: clamped.length < long.length,
    shortStaysWhole: clampTranscript(head) === head,
  }
}

// 3b. 压第二次：边界必须继续往前走，不能退回上一个压缩点之前
{
  const all = conversation(9)
  const first = compactionPoint(all, 400)
  const withCompact = [
    ...all,
    ev('session/compact', T0 + 100 * MIN, {
      throughSeq: first.seq,
      from: T0,
      to: first.time,
      summary: '第一次的摘要',
      droppedMessages: 5,
      tokensBefore: 900,
      tokensAfter: 300,
    }),
  ]
  // 预算给足，让两边都去挑「最早的可切点」——差别才看得出来。
  const scoped = compactionPoint(scopeAfterBoundary(withCompact), 1e9)
  const naive = compactionPoint(withCompact, 1e9)
  out.second = {
    movesForward: scoped.seq > first.seq,
    // 不做 scope 的话会挑到更早的位置——而 toAgentMessages 只认最后一条压缩事件，
    // 于是上次压掉的原文又回来了。这一行就是那个 bug 的现场。
    naiveGoesBackward: naive.seq <= first.seq,
  }
}

// 3d. 重置点（/new）：截断照做，但不留摘要
{
  const all = conversation(6)
  const ends = all.filter((e) => e.type === 'turn/end')
  const cut = ends[ends.length - 2] // 留最后一整轮，跟 resetContext 切的位置同一个形状
  const withReset = [
    ...all,
    ev('session/reset', T0 + 999 * MIN, {
      throughSeq: cut.seq,
      from: T0,
      to: cut.time,
      droppedMessages: 10,
      by: 'user',
    }),
  ]
  const msgs = await toAgentMessages(withReset)
  const texts = msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
  const roles = msgs.map((m) => m.role)
  out.reset = {
    // 前面那几轮一句都不该留下
    leakedOld: texts.some((t) => t.includes('问题1') || t.includes('问题5')),
    keptLast: texts.some((t) => t.includes('问题6')),
    // 重置点不留摘要——这正是它跟压缩点的唯一区别
    noSummaryHead: !texts.some((t) => t.includes('[对话摘要')),
    startsWithUser: roles[0] === 'user',
    consecutiveSameRole: roles.some((r, i) => i > 0 && r === roles[i - 1]),
  }
}

// 3e. 两种边界混着来：contextBoundary / scopeAfterBoundary 必须都认最后那一条
//
// 只认 compact 的话，/new 之后的第一次自动压缩会从重置点**之前**挑边界，
// 把人刚扔掉的原文整段放回上下文——那一刀于是无声失效，且没有任何报错。
{
  const all = conversation(9)
  const ends = all.filter((e) => e.type === 'turn/end')
  const compactAt = ends[1]
  const resetAt = ends[4]
  const mixed = [
    ...all,
    ev('session/compact', T0 + 500 * MIN, {
      throughSeq: compactAt.seq,
      from: T0,
      to: compactAt.time,
      summary: '第一次的摘要',
      droppedMessages: 4,
      tokensBefore: 900,
      tokensAfter: 300,
      by: 'auto',
    }),
    ev('session/reset', T0 + 600 * MIN, {
      throughSeq: resetAt.seq,
      from: compactAt.time,
      to: resetAt.time,
      droppedMessages: 6,
      by: 'user',
    }),
  ]
  const scoped = compactionPoint(scopeAfterBoundary(mixed), 1e9)
  // 反过来的顺序：先 reset 再 compact，最后一条是 compact，摘要要回来
  const reversed = [
    ...all,
    ev('session/reset', T0 + 500 * MIN, {
      throughSeq: compactAt.seq,
      from: T0,
      to: compactAt.time,
      droppedMessages: 4,
      by: 'user',
    }),
    ev('session/compact', T0 + 600 * MIN, {
      throughSeq: resetAt.seq,
      from: compactAt.time,
      to: resetAt.time,
      summary: '重置之后又压了一次',
      droppedMessages: 6,
      tokensBefore: 800,
      tokensAfter: 200,
      by: 'auto',
    }),
  ]
  const revTexts = (await toAgentMessages(reversed)).map((m) =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  )
  out.mixed = {
    boundaryIsLast: contextBoundary(mixed)?.type === 'session/reset',
    // 认对了边界，新切点必须落在 reset 之后；认成 compact 就会退回它前面
    movesPastReset: scoped.seq > resetAt.seq,
    reversedBoundary: contextBoundary(reversed)?.type === 'session/compact',
    reversedHasSummary: revTexts.some((t) => t.includes('重置之后又压了一次')),
    reversedLeakedOld: revTexts.some((t) => t.includes('问题1')),
  }
}

// 4. 时间区间按席位时区解析（探针由 e2e 侧钉死 SATUWORK_TZ）
{
  const since = parseAt('2026-08-18', 'since', false)
  const until = parseAt('2026-08-18', 'until', true)
  const withTime = parseAt('2026-08-18 22:10', 'since', false)
  out.parse = {
    // Asia/Shanghai 的 8/18 00:00 = UTC 8/17 16:00
    sinceIso: new Date(since).toISOString(),
    untilIso: new Date(until).toISOString(),
    withTimeIso: new Date(withTime).toISOString(),
    spanHours: (until - since) / 3600_000,
    empty: parseAt('', 'since', false) === undefined,
  }
}

// 4b. 两种 arguments 形状要得出同样的文本：日志里是 JSON 字符串，pi 消息里是对象
{
  const raw = '{"path":"a/b.ts","limit":20}'
  const fromLog = contentDigest([{ type: 'tool-call', callId: 'c', name: 'read', arguments: raw }])
  const fromPi = contentDigest([{ type: 'toolCall', id: 'c', name: 'read', arguments: JSON.parse(raw) }])
  out.digest = {
    same: fromLog === fromPi,
    // 二次编码会把每个双引号变成 \"，长度凭空涨一截，估算跟着偏大
    noEscapedQuotes: !fromLog.includes('\\"'),
    fromLog,
  }
}

// 5. rowsOf 把事件铺成可读的行，工具结果也在里面
{
  const rows = rowsOf(conversation(3))
out.rows = {
    roles: [...new Set(rows.map((r) => r.role))].sort(),
    hasToolOutput: rows.some((r) => r.text.includes('工具输出3')),
    ordered: rows.every((r, i) => i === 0 || rows[i - 1].time <= r.time),
  }
}

// 6. 超大连接器结果：完整原文留档，模型只回放受控版本；老日志也即时生效。
{
  seq = 0
  const body = '邮件正文。'.repeat(8_000)
  const raw = JSON.stringify({
    messages: Array.from({ length: 20 }, (_, i) => ({
      messageId: `m-${i}`,
      subject: `subject ${i}`,
      messageText: body,
      payload: { body: { data: 'QUJD'.repeat(5_000) } },
    })),
  })
  const budgeted = budgetToolText('mcp_gmail_default_fetch_emails', raw)
  const old = [
    ev('assistant/message', T0, {
      turn: 1,
      step: 1,
      message: {
        id: 'a',
        role: 'assistant',
        content: [{ type: 'tool-call', callId: 'mail', name: 'mcp_gmail_default_fetch_emails', arguments: '{}' }],
      },
      usage: { inputTokens: 263, outputTokens: 1, cacheReadTokens: 664_960, reasoningTokens: 0 },
    }),
    ev('tool/result', T0 + 1, { turn: 1, step: 1, callId: 'mail', text: raw, failed: false }),
  ]
  const replay = await toAgentMessages(old)
  const replayText = replay.find((m) => m.role === 'toolResult')?.content?.[0]?.text ?? ''
  /**
   * 下面两条是从 bot/e2e-result-budget.mjs 并过来的——那个探针没有任何套件引用，
   * 它独有的断言从来没跑过。
   *
   * - 对外历史（界面翻历史那条路，historySlice）也要瘦身，而且同样不许改写服务端日志。
   * - 压缩边界之前那个 66 万的高水位不能污染压缩后的新上下文；边界之后的新 usage 才算。
   */
  const publicTool = historySlice(old).events.find((e) => e.type === 'tool/result')
  const compacted = [
    ...old,
    ev('turn/end', T0 + 2, { turn: 1, reason: 'completed' }),
    ev('session/compact', T0 + 3, {
      throughSeq: seq,
      from: T0,
      to: T0 + 3,
      summary: 'summary',
      by: 'auto',
      tokensBefore: 665_223,
      tokensAfter: 100,
    }),
  ]
  const highWaterAfterCompact = observedPromptHighWater(compacted)
  compacted.push(
    ev('assistant/message', T0 + 4, {
      turn: 2,
      step: 1,
      message: { id: 'b', role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      usage: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 2_000, reasoningTokens: 0 },
    }),
  )
  const highWaterNext = observedPromptHighWater(compacted)
  out.resultBudget = {
    rawChars: raw.length,
    modelChars: budgeted.text.length,
    replayChars: replayText.length,
    rawPreserved: budgeted.rawText === raw && old[1].data.text === raw,
    payloadRemoved: !budgeted.text.includes('"payload":'),
    underHardLimit: budgeted.text.length <= MODEL_TOOL_RESULT_MAX_CHARS,
    oldLogSlimmed: replayText.length === budgeted.text.length,
    promptHighWater: observedPromptHighWater(old),
    publicHistoryChars: publicTool?.data?.text?.length ?? -1,
    publicHistorySlimmed:
      (publicTool?.data?.text?.length ?? Infinity) <= MODEL_TOOL_RESULT_MAX_CHARS && old[1].data.text === raw,
    highWaterAfterCompact,
    highWaterNext,
  }
}

// 压缩窗口压到价格门槛以下：gpt-6.1-sol 窗口 105 万、过 272k 整次翻倍
{
  const tier = (above) => ({ inputTokensAbove: above, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 0 })
  const base = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 }
  out.priceCliff = {
    tiered: compactionWindow(1_050_000, { ...base, tiers: [tier(272_000)] }),
    lowestOfMany: compactionWindow(1_050_000, { ...base, tiers: [tier(500_000), tier(272_000)] }),
    noTiers: compactionWindow(1_050_000, base),
    noCost: compactionWindow(128_000, undefined),
    cliffAboveWindow: compactionWindow(200_000, { ...base, tiers: [tier(272_000)] }),
    junk: compactionWindow(400_000, { tiers: [null, { inputTokensAbove: 0 }, { inputTokensAbove: 'x' }] }),
  }
}

console.log('__RESULT__' + JSON.stringify(out))
