/**
 * Responses 协议这条路。探针在 bot/e2e-responses.mjs（要 tsx 才 import 得了 .ts）。
 *
 * `api: 'openai-responses'` 的模型以前也被塞进 /v1/chat/completions；中继之后请求体原样打到
 * 上游，gpt-5.6-sol 这一批「工具 + reasoning_effort」一起出现就 400。钉三件事：选到
 * /v1/responses、请求体是 Responses 的形状、事件流装得回 pi 的消息。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-responses.mjs', { timeout: 30_000 })

export async function runResponses({ root, test, assert, log }) {
  log('\n# responses')
  const r = await runProbe(root)

  await test('openai-responses 的模型走 /v1/responses，推理档是 reasoning.effort', () => {
    const req = r.toolTurn.request
    assert(req?.path === '/v1/responses', `打到了 ${req?.path}`)
    const b = req.body
    assert(!('reasoning_effort' in b) && !('messages' in b), `混进了 chat 的字段：${Object.keys(b).join(',')}`)
    assert(b.reasoning?.effort === 'high', `推理档不对：${JSON.stringify(b.reasoning)}`)
    assert(b.store === false && b.stream === true, `store/stream 不对：${b.store}/${b.stream}`)
    assert(b.instructions === '你是助手', `system 没进 instructions：${JSON.stringify(b.instructions)}`)
    assert(b.model === 'openai/gpt-5.6-sol' && b.provider === 'openai', `model/provider：${b.model} ${b.provider}`)
    const tool = b.tools?.[0]
    assert(tool?.type === 'function' && tool.name === 'web_search' && tool.parameters?.type === 'object', `工具形状不对：${JSON.stringify(tool)}`)
  })

  await test('历史换成 Responses 的输入条目：图、调用、结果都对得上', () => {
    const input = r.toolTurn.request.body.input
    const types = input.map((i) => i.type || i.role).join(',')
    assert(types === 'user,assistant,function_call,function_call_output,user', `条目顺序：${types}`)
    const img = input[0].content.find((c) => c.type === 'input_image')
    assert(img?.image_url === 'data:image/png;base64,AAAA', `图没带上：${JSON.stringify(input[0].content)}`)
    assert(input[0].content.some((c) => c.type === 'input_text' && c.text === '看图'), '图旁边的字丢了')
    const call = input[2]
    const result = input[3]
    assert(/^[a-zA-Z0-9_-]+$/.test(call.call_id), `call_id 没规整：${call.call_id}`)
    assert(call.call_id === result.call_id, `调用和结果的 id 对不上：${call.call_id} / ${result.call_id}`)
    assert(call.arguments === '{}' && result.output === '十点', `参数/结果：${call.arguments} ${result.output}`)
  })

  await test('事件流装回来：跳过推理条目，正文和工具各归各位，usage 减掉缓存', () => {
    const t = r.toolTurn
    assert(!t.error, `报错了：${t.error}`)
    assert(t.blocks.join(',') === 'text,toolCall', `块：${t.blocks.join(',')}`)
    assert(t.text === '我先查一下。', `正文：${t.text}`)
    assert(t.tools.length === 1 && t.tools[0].id === 'call_x' && t.tools[0].name === 'web_search', `工具：${JSON.stringify(t.tools)}`)
    assert(t.tools[0].args.q === '印尼 山火', `参数：${JSON.stringify(t.tools[0].args)}`)
    assert(t.stopReason === 'toolUse', `stopReason：${t.stopReason}`)
    assert(t.usage.input === 60 && t.usage.cacheRead === 40 && t.usage.output === 20, `usage：${JSON.stringify(t.usage)}`)
  })

  await test('推理关着就不发 reasoning；顶到输出上限记成 length', () => {
    assert(!('reasoning' in r.cut.request.body), `off 时不该带 reasoning：${JSON.stringify(r.cut.request.body.reasoning)}`)
    assert(r.cut.text === '写到一半' && r.cut.stopReason === 'length', `${r.cut.text} / ${r.cut.stopReason}`)
  })

  await test('response.failed 要报成错，不是空回答', () => {
    assert(r.failed.error === '上游炸了', `错误：${JSON.stringify(r.failed)}`)
  })

  await test('非流式补全也按目录选到 /v1/responses，正文从 output 里的 message 取', () => {
    const o = r.once
    assert(o.request?.path === '/v1/responses', `打到了 ${o.request?.path}`)
    assert(o.request.body.reasoning?.effort === 'low' && o.request.body.stream === false, `请求体：${JSON.stringify(o.request.body)}`)
    assert(o.ok && o.text === '摘要在此', `正文：${JSON.stringify(o)}`)
  })
}
