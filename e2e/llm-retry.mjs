/**
 * 模型调用的瞬时失败重发。探针在 bot/e2e-llm-retry.mjs（要 tsx 才 import 得了 .ts）。
 *
 * 一次「fetch failed」就让整轮以 error 收口，派出去的活跟着算没做成——而隔一秒再发一次就好了。
 * 反过来也要守住：已经开始吐字之后才断的不能重发，否则同一段话、同一把工具会再来一遍。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const RETRIES = 2

const runProbe = (root) =>
  sharedProbe(root, 'bot/e2e-llm-retry.mjs', { env: { SATUWORK_LLM_RETRY_MS: '10', SATUWORK_LLM_RETRIES: String(RETRIES) }, timeout: 30_000 })

export async function runLlmRetry({ root, test, assert, log }) {
  log('\n# llm-retry')
  let r
  const texts = (x) => x.events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('')
  const errors = (x) => x.events.filter((e) => e.type === 'error').map((e) => e.error)
  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.http503 && r.midway, `探针结果不完整：${JSON.stringify(r)}`)
  })

  await test('Gateway 回 503（上游 fetch failed）：重发一次就拿到回答，不报错', async () => {
    assert(r.http503.hits === 2, `该打两次，实际 ${r.http503.hits}`)
    assert(texts(r.http503) === '好了' && !errors(r.http503).length, `事件不对：${JSON.stringify(r.http503.events)}`)
  })

  await test('流里头一帧就是错误帧：同样重发，第一次那条错误不交给 pi', async () => {
    assert(r.frame.hits === 2, `该打两次，实际 ${r.frame.hits}`)
    assert(texts(r.frame) === '好了' && !errors(r.frame).length, `事件不对：${JSON.stringify(r.frame.events)}`)
  })

  await test('明确的请求错误（400）不重发', async () => {
    assert(r.bad.hits === 1, `不该重发，实际打了 ${r.bad.hits} 次`)
    assert(errors(r.bad)[0] === 'context length exceeded', `错误原话没交出去：${JSON.stringify(r.bad.events)}`)
  })

  await test('一直失败：重发到上限就停，交出最后那条错误', async () => {
    assert(r.down.hits === RETRIES + 1, `该打 ${RETRIES + 1} 次，实际 ${r.down.hits}`)
    assert(errors(r.down).length === 1, `该只有一条错误：${JSON.stringify(r.down.events)}`)
  })

  await test('已经开始吐字之后才断的不重发：前面那截照交，接着是那条错误', async () => {
    assert(r.midway.hits === 1, `不该重发，实际打了 ${r.midway.hits} 次`)
    assert(texts(r.midway) === '写到一半' && errors(r.midway)[0] === 'fetch failed', `事件不对：${JSON.stringify(r.midway.events)}`)
  })
}
