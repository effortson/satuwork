/**
 * 上下文压缩与翻历史的语义。探针在 bot/e2e-compact.mjs（纯函数，要 tsx）。
 *
 * 压缩是「一个 Bot 一条长会话」这个方案能成立的前提，而它错起来有两种面孔：
 * 一种是当场炸（边界切在轮次中间，provider 拒收），一种是悄悄变笨（旧事件还在发、
 * 或者摘要没进上下文、或者时间区间偏了 8 小时）。后一种要靠这里钉住。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const TZ = 'Asia/Shanghai'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-compact.mjs', { env: { SATUWORK_TZ: TZ } })

export async function runCompact({ root, test, assert, log }) {
  log('\n# compact')
  const r = await runProbe(root)

  await test('压缩边界只落在 turn/end 上，不留孤儿 tool_result', () => {
    assert(r.boundary.type === 'turn/end', `边界事件是 ${r.boundary.type}，必须是 turn/end`)
    // 这条挂了意味着线上会收到 provider 的 400：
    // 「role 'tool' 必须紧跟在带 tool_calls 的消息之后」。
    assert(
      r.boundary.orphanToolResults === 0,
      `保留段里有 ${r.boundary.orphanToolResults} 条工具结果找不到它的助手消息`,
    )
  })

  await test('预算宽就多留原文，预算紧也至少留最后一轮', () => {
    assert(r.budget.roomy, '预算足够时应该切在最早的可切点，尽量少压')
    assert(r.budget.tight, '预算为 0 时应该切在最靠后的可切点，但仍要留最后一轮')
    assert(r.budget.tooShort, '只有一轮时无处可切，应该返回 undefined 而不是硬切')
  })

  await test('有压缩点之后：摘要顶在最前，旧事件不再逐条回传', () => {
    assert(r.compacted.first?.startsWith('[对话摘要 ·'), `第一条应是摘要，实际 ${r.compacted.first}`)
    assert(r.compacted.hasSummaryBody, '摘要正文没进去')
    // 覆盖区间写在摘要抬头里——压缩之后「昨天」还要答得出来，靠的就是这个。
    assert(/\d+年\d+月\d+日/.test(r.compacted.first), `摘要抬头缺时间区间：${r.compacted.first}`)
    assert(!r.compacted.leakedOldQuestion, '被压掉的轮次又回到上下文里了，等于没压')
    assert(r.compacted.keptLatestQuestion, '最近一轮被压掉了')
    assert(r.compacted.shorterThanFull, '压完之后消息数没变少')
  })

  await test('摘要并进第一条用户消息，不产生连续同角色', () => {
    assert(r.compacted.summaryMergedIntoFirstUser, '摘要没有并进保留段的第一条用户消息')
    // 压缩边界固定落在 turn/end 上，其后第一条必然是 user。摘要要是自己占一条，
    // 前两条就都是 user——Anthropic 会以 roles must alternate 拒掉整个请求，
    // 而 OpenAI 兼容口一切正常，本地根本照不出来。
    assert(!r.compacted.consecutiveSameRole, '出现了两条连续的 user 消息')
  })

  await test('摘要输入超长时掐中间，上一次的摘要必须留住', () => {
    // 只留末尾的话，级联压缩时第一个被丢掉的就是上一次的摘要——新摘要因此不含
    // 第一次压缩之前的任何事实，摘要链当场断掉，而且不报任何错。
    assert(r.clamp.keepsHead, '头部被切掉了，上一次的摘要就是在这个位置')
    assert(r.clamp.keepsTail, '尾部（最近的对话）被切掉了')
    assert(r.clamp.saysDropped, '省略了中间却没说，模型会以为自己看到了全文')
    assert(r.clamp.shrank, '没有真正缩短')
    assert(r.clamp.shortStaysWhole, '没超限的输入被改动了')
  })

  await test('压第二次时边界继续往前，不退回上一个压缩点之前', () => {
    assert(r.second.movesForward, '第二次压缩挑的边界没有越过第一次的压缩点')
    // toAgentMessages 只认最后一条压缩事件。边界要是退回去了，上次压掉的原文就整段
    // 回到上下文里——症状是「越压越大」，而且没有任何报错。
    assert(r.second.naiveGoesBackward, '这条不成立说明用例没造出会退化的场景，断言就白写了')
  })

  await test('重置点（/new）截断照做，但不留摘要', () => {
    assert(!r.reset.leakedOld, '重置点之前的对话又回到上下文里了，/new 等于没点')
    assert(r.reset.keptLast, '边界之后的那一轮被一起切掉了')
    // 这条是 /new 跟 /compact 的唯一区别。留了摘要就是压缩，不是重开。
    assert(r.reset.noSummaryHead, '重置点不该留摘要')
    assert(r.reset.startsWithUser, '重置之后第一条应该是用户消息')
    assert(!r.reset.consecutiveSameRole, '出现了两条连续同角色的消息')
  })

  await test('压缩点和重置点混着来时，只认最后那一条', () => {
    assert(r.mixed.boundaryIsLast, 'contextBoundary 没认出最后那条边界')
    // 这条挂了 = scopeAfterBoundary 只认 compact：/new 之后的第一次自动压缩会从
    // 重置点之前挑边界，把人刚扔掉的原文整段放回上下文，而且不报任何错。
    assert(r.mixed.movesPastReset, '新切点退回到了重置点之前')
    assert(r.mixed.reversedBoundary, '反过来的顺序里没认出最后那条是压缩点')
    assert(r.mixed.reversedHasSummary, '最后一条是压缩点时，摘要必须回到上下文里')
    assert(!r.mixed.reversedLeakedOld, '边界之前的原文泄漏了')
  })

  await test('时间区间按席位时区解析，不是 UTC', () => {
    // Asia/Shanghai 的 8/18 00:00 就是 UTC 的 8/17 16:00。
    // 这条挂了 = 直接 Date.parse，「取昨天」会整整偏出 8 小时。
    assert(r.parse.sinceIso === '2026-08-17T16:00:00.000Z', `since 解析成了 ${r.parse.sinceIso}`)
    assert(r.parse.untilIso === '2026-08-18T15:59:59.000Z', `until 解析成了 ${r.parse.untilIso}`)
    assert(r.parse.withTimeIso === '2026-08-18T14:10:00.000Z', `带时刻的解析成了 ${r.parse.withTimeIso}`)
    assert(r.parse.spanHours > 23.9 && r.parse.spanHours < 24, `只给日期时应覆盖整天，实际 ${r.parse.spanHours} 小时`)
    assert(r.parse.empty, '空字符串应视为不限，不是 1970 年')
  })

  await test('工具参数两种形状估算出同一段文本，不二次编码', () => {
    // 日志事件里 arguments 已经是 JSON 字符串，再 stringify 一遍会包引号并转义，
    // 长度凭空涨五成——带大量工具调用的会话因此被高估，压缩切得比需要的早。
    assert(r.digest.same, `两种形状得出的文本不一致：${r.digest.fromLog}`)
    assert(r.digest.noEscapedQuotes, `参数被二次编码了：${r.digest.fromLog}`)
  })

  await test('翻历史能看到用户、助理和工具三种记录', () => {
    assert(r.rows.roles.length === 3, `角色应有三种，实际 ${JSON.stringify(r.rows.roles)}`)
    assert(r.rows.hasToolOutput, '工具结果没出现在历史里')
    assert(r.rows.ordered, '历史行不是按时间升序的')
  })

  await test('超大 Gmail 结果保留审计原文，但模型与旧日志回放都受预算控制', () => {
    assert(r.resultBudget.rawChars > 1_000_000, `用例没有造出足够大的结果：${r.resultBudget.rawChars}`)
    assert(r.resultBudget.rawPreserved, '完整工具原文没有保留下来')
    assert(r.resultBudget.payloadRemoved, '邮件列表仍把重复 payload 送进模型')
    assert(r.resultBudget.underHardLimit, `模型工具结果仍超上限：${r.resultBudget.modelChars}`)
    assert(r.resultBudget.oldLogSlimmed, '没有 modelText 的旧会话在回放时没有即时瘦身')
    assert(r.resultBudget.promptHighWater === 665_223, `真实 prompt 高水位算成了 ${r.resultBudget.promptHighWater}`)
    // 从 bot/e2e-result-budget.mjs 并过来的两条（那个探针没有套件引用，从来没跑过）。
    assert(r.resultBudget.publicHistorySlimmed, `对外历史没瘦身或改写了服务端日志：${r.resultBudget.publicHistoryChars} 字符`)
    assert(r.resultBudget.highWaterAfterCompact === 0, `压缩边界之前的高水位漏到了新上下文：${r.resultBudget.highWaterAfterCompact}`)
    assert(r.resultBudget.highWaterNext === 2_100, `边界之后的新 usage 没算上：${r.resultBudget.highWaterNext}`)
  })

  await test('带长上下文档位的模型按价格门槛压，不按窗口', () => {
    // 只按窗口的话 gpt-6.1-sol 要到 63 万才压，27 万以上每一次调用都是两倍价。
    assert(r.priceCliff.tiered === 272_000, `有档位时压缩窗口应是门槛 272000，实际 ${r.priceCliff.tiered}`)
    assert(r.priceCliff.lowestOfMany === 272_000, `多档时应取最低门槛，实际 ${r.priceCliff.lowestOfMany}`)
    assert(r.priceCliff.noTiers === 1_050_000, `没有档位应是窗口本身，实际 ${r.priceCliff.noTiers}`)
    assert(r.priceCliff.noCost === 128_000, `目录没给 cost 应是窗口本身，实际 ${r.priceCliff.noCost}`)
    assert(r.priceCliff.cliffAboveWindow === 200_000, `门槛比窗口大时应是窗口，实际 ${r.priceCliff.cliffAboveWindow}`)
    assert(r.priceCliff.junk === 400_000, `脏档位应被忽略，实际 ${r.priceCliff.junk}`)
  })

  await test('轮内护栏：逼近窗口时省掉模型看过的早先工具结果，刚回来的不动', () => {
    const g = r.turnGuard
    // 输入上限 = 窗口 − 最大输出；目录把最大输出写得离谱时最多扣一半
    assert(JSON.stringify(g.limits) === JSON.stringify([972_000, 200_000, 50_000]), `输入上限算错：${JSON.stringify(g.limits)}`)
    assert(JSON.stringify(g.firstElided) === JSON.stringify([2, 4]), `应省掉第 2、4 条（c1、c2），实际 ${JSON.stringify(g.firstElided)}`)
    assert(g.freshKept, '刚回来、模型还没看过的工具结果被省了——这次调用等于白做')
    assert(g.placeholderHasHead, '占位里没留原文开头，模型认不出省掉的是哪次调用')
    assert(g.othersUntouched, '用户/助手消息被动了')
    assert(g.notMutated, '护栏改了传进来的消息——会话状态和日志会跟着变')
    assert(g.elideCalls === 1 && g.elideFirst.projected <= g.elideFirst.limit * 0.85, `省完仍在触发线以上：${JSON.stringify(g.elideFirst)}`)
    // 省过的要一直省：每次从零挑的话，请求前缀来回变，提示词缓存一次也命中不了
    assert(JSON.stringify(g.secondElided) === JSON.stringify([2, 4]), `第二步没沿用已省的那两条：${JSON.stringify(g.secondElided)}`)
    assert(g.quietSame, '没到触发线也动了消息')
    // 19:35 那种：上一轮撞了窗口，这一轮一上来本地估算偏低，没有 prior 就会再撞一次
    assert(g.priorElided === 2, `有 provider 高水位兜底时第一次调用就该省，实际省了 ${g.priorElided} 条`)
    assert(g.noPriorQuiet, '对照组：没有高水位时本地估算不到线，不该动')
    assert(g.staleIgnored, '把本轮之前（可能在压缩之前）的 usage 当成了实测')
    assert(g.freshCounted, '对照组：本轮的实测应该触发省略')
    assert(g.tightSmallKept, '小结果不值得省，却被省了')
    assert(g.tightFreshKept, '唯一的大结果是刚回来的，不该省')
    assert(g.tightExhausted === 1, `全省完仍超时应报一次，实际 ${g.tightExhausted}`)
    assert(g.brokenPassThrough, '估算抛错时护栏应原样放行，不能把这一轮带崩')
  })

  await test('摘要模型返回 Promise 时也读得出摘要（生产上的形状）', () => {
    const s = r.summaryCall
    // 这条挂了 = 生产上每次压缩都报「stream is not async iterable」，会话一路涨到撞窗口
    assert(s.asyncText === '摘要正文', `streamFn 返回 Promise 时没读出摘要：${s.asyncText}`)
    assert(s.syncText === '同步也行', `同步返回流时没读出摘要：${s.syncText}`)
    assert(s.errorText === '', `模型出错时应返回空串当「没压成」，实际 ${s.errorText}`)
    assert(s.sentTranscript === '旧对话', `送去摘要的不是那段对话：${s.sentTranscript}`)
    assert(s.sentNoTools, '摘要调用不该带工具表')
  })
}
