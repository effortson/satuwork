/**
 * 模型流的空闲看门狗。探针在 bot/e2e-llm-idle.mjs（要 tsx 才 import 得了 .ts）。
 *
 * 为什么值得单开一个套件：这是**不报错的那类故障**。上游静默断掉时进程活着、端口
 * 听着、systemd 说 active，只是那一轮永远不结束，界面永远挂着「正在处理」。没有测试
 * 守着，它下次回来也一样查不出来。
 */
import { runProbe as sharedProbe } from './probe.mjs'

// 比 gateway.ts 里那个防呆下限（1 秒）高一点，否则被夹上去，测的就不是自己设的值了。
const IDLE_MS = 1200

const runProbe = (root) => sharedProbe(root, 'bot/e2e-llm-idle.mjs', { env: { SATUWORK_LLM_IDLE_MS: String(IDLE_MS) }, timeout: 30_000 })

export async function runLlmIdle({ root, test, assert, log }) {
  log('\n# llm-idle')
  let r
  await test('探针跑得完（流自己收口了，没挂住）', async () => {
    r = await runProbe(root)
    assert(r && r.silent && r.alive && r.headless && r.relay, `探针结果不完整：${JSON.stringify(r)}`)
  })

  await test('设了 GATEWAY_LLM_URL：补全打管家的转发口，不碰 GATEWAY_URL', async () => {
    // 席位上 provider 密钥只在管家进程里，/v1/* 必须走转发口；末尾斜杠也得收掉。
    assert(JSON.stringify(r.relay.paths) === JSON.stringify(['/llm/v1/chat/completions']), `请求打错了地方：${JSON.stringify(r.relay.paths)}`)
    const texts = r.relay.events.filter((e) => e.type === 'text_delta')
    assert(texts.length > 0, `转发口没收到正文：${JSON.stringify(r.relay.events)}`)
  })

  await test('上游静默不动：判定断开并收口，不再无限等下去', async () => {
    const last = r.silent.events[r.silent.events.length - 1]
    assert(last && last.type === 'error', `静默流最后不是 error：${JSON.stringify(r.silent.events)}`)
    assert(/判定上游已断开/.test(last.error), `没说清是超时：${JSON.stringify(last.error)}`)
    // 收口要靠空闲判据，不是靠某个总时长上限——所以它必须**紧挨着**空闲上限发生。
    assert(r.silent.ms >= IDLE_MS, `${r.silent.ms}ms 就断了，比空闲上限还早，判据不对`)
    assert(r.silent.ms < IDLE_MS * 8, `等了 ${r.silent.ms}ms 才断，空闲上限没起作用`)
  })

  await test('连响应头都不给：一样要收口，别卡在建连上', async () => {
    // 静默有两种落点：头都没来（卡在 fetch）和头来了正文断了（卡在读循环）。
    // 只堵后一种的话，上游 accept 了连接却再不回话时照样挂死。
    const last = r.headless.events[r.headless.events.length - 1]
    assert(last && last.type === 'error', `没收口：${JSON.stringify(r.headless.events)}`)
    assert(/判定上游已断开/.test(last.error), `没说清是超时：${JSON.stringify(last.error)}`)
  })

  await test('慢但活着的流不能误杀——只会掐是不算修好的', async () => {
    // 心跳把总时长撑到空闲上限的好几倍，但两次字节之间从没超过上限。
    assert(r.alive.ms > IDLE_MS, `慢流只跑了 ${r.alive.ms}ms，没撑过空闲上限，这条没测到东西`)
    const texts = r.alive.events.filter((e) => e.type === 'text_delta')
    assert(texts.length > 0, `慢流没收到正文：${JSON.stringify(r.alive.events)}`)
    const bad = r.alive.events.find((e) => /判定上游已断开/.test(e.error || ''))
    assert(!bad, `活着的流被超时误杀了：${JSON.stringify(bad)}`)
  })
}
