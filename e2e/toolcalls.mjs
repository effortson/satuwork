/**
 * 流式装配工具调用。探针在 bot/e2e-toolcalls.mjs（要 tsx 才 import 得了 .ts）。
 *
 * 为什么值得单开一个套件：这一层坏了**不报错**。上游给的下标错位一格，界面上就多一颗
 * 空壳「tool · 失败」（或者少一把真调用），而日志、状态码、类型检查全都干干净净——
 * 只有对着一段真实形状的 SSE 跑一遍才看得出来。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-toolcalls.mjs', { timeout: 30_000 })

export async function runToolCalls({ root, test, assert, log }) {
  log('\n# toolcalls')
  const r = await runProbe(root)

  await test('上游从 index:1 起给工具：不许在 0 位补出一个空壳', () => {
    const names = r.offsetIndex.tools.map((t) => t.name)
    // 空壳就是那颗红色的「tool · 失败」：名字空、id 空、参数空，pi 找不到这个工具，
    // 立刻判失败。它从来没跑过，也代表不了任何一件真出过错的事。
    assert(
      !r.offsetIndex.tools.some((t) => !t.name),
      `混进了没有名字的工具调用：${JSON.stringify(r.offsetIndex.tools)}`,
    )
    assert(names.join(',') === 'web_search,web_extract', `工具对不上：${names.join(',')}`)
    assert(r.offsetIndex.tools[0].args.q === '印尼 山火', '参数没拼回去')
  })

  await test('正文先来时，第一把工具不能落到正文块上', () => {
    const names = r.textFirst.tools.map((t) => t.name)
    // 少一把工具比多一颗空壳更坏：界面上什么都看不到，模型却以为自己调过了。
    assert(names.join(',') === 'web_search,now', `丢了工具：${names.join(',')}`)
    assert(r.textFirst.text === '我先查一下。', `正文被工具增量写坏了：${r.textFirst.text}`)
    assert(r.textFirst.blocks.join(',') === 'text,toolCall,toolCall', `块的顺序不对：${r.textFirst.blocks.join(',')}`)
  })

  await test('日志里已经留下的空壳：重建历史时连它的结果一起丢掉', () => {
    // 装配那一处修好了，可**已经写下的日志改不了**。回传一把叫「」的工具，好一点是白占
    // token，坏一点是上游拒收整条请求（name 空、tool_call_id 空），这个会话从此答不了话。
    assert(
      r.replay.calls.length === 1 && r.replay.calls[0].name === 'web_search',
      `空壳还在往模型那儿回传：${JSON.stringify(r.replay.calls)}`,
    )
    // 必须成对丢：只丢调用会留下一条无主的 toolResult，Anthropic 那边同样是硬拒。
    assert(r.replay.results.join(',') === 'call_a', `工具结果没配平：${JSON.stringify(r.replay.results)}`)
  })

  await test('进程死在一步中间（助手消息没落盘）：拿 tool/call 补回来，已落盘的结果不丢', () => {
    const c = r.crashed
    assert(c.roles.join(',') === 'user,assistant,toolResult,toolResult,user', `顺序：${c.roles.join(',')}`)
    assert(c.calls.join(',') === 'send_email,terminal', `补出来的调用：${c.calls.join(',')}`)
    assert(c.results.includes('call_mail:ok:已发送'), `已发出的那封邮件结果丢了：${JSON.stringify(c.results)}`)
    assert(c.results.some((x) => x.startsWith('call_sh:err:')), `没跑完的那把要补一条被中断：${JSON.stringify(c.results)}`)
  })

  await test('老老实实从 0 起、没有正文的那种，一个字都不许变', () => {
    assert(r.plain.tools.length === 1 && r.plain.tools[0].name === 'now', `常规那条被改坏了：${JSON.stringify(r.plain.tools)}`)
    assert(r.plain.starts.join(',') === '0', `toolcall_start 的下标不对：${r.plain.starts.join(',')}`)
  })
}
