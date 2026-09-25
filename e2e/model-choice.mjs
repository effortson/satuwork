/**
 * 会话级的日常模型选择。探针在 bot/e2e-model-choice.mjs，设计见 docs/model-choice.md。
 *
 * 这一组守的线同样**不会自己喊出来**：选择器上写着 A、进模型的却是 B，每一轮照样跑成、
 * 照样出话。所以每一条都落在「真正送进模型的是哪个」上，而不是「接口回了 200」。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-model-choice.mjs', { env: { GATEWAY_URL: '', GATEWAY_API_KEY: '', SATUWORK_BOT_ID: '' } })

/** 一组里哪几条是假的。断言信息里直接列出来，比一句「不对」好查得多。 */
const failed = (group) => Object.entries(group || {}).filter(([, v]) => v !== true).map(([k]) => k)

export async function runModelChoice({ root, test, assert, log }) {
  log('\n# model-choice')
  let r
  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.options && r.pick && r.reject && r.running && r.routine && r.removed && r.cold && r.reset && r.channel, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('名单：默认排第一，备选跟在后面，和默认重复的不出现', () => {
    assert(!failed(r.options).length, `名单不对：${failed(r.options).join('、')}`)
  })

  await test('挑了备选，下一轮送进模型的就是它，推理强度用它自己的', () => {
    assert(!failed(r.pick).length, `挑了没生效：${failed(r.pick).join('、')}——选择器上写着一个，跑的是另一个`)
  })

  await test('名单外的拒掉，挑选原样不动', () => {
    assert(!failed(r.reject).length, `${failed(r.reject).join('、')}——这条路浏览器也走得通，收任意值就是白名单的后门`)
  })

  await test('跑着的时候也能挑：这一轮不变，下一轮才换，并且如实说', () => {
    assert(!failed(r.running).length, `跑着时挑：${failed(r.running).join('、')}`)
  })

  await test('定时任务选 daily 跟着会话的挑选，utility 不受影响', () => {
    assert(!failed(r.routine).length, `定时任务：${failed(r.routine).join('、')}`)
  })

  await test('挑的那个被下架：下一轮退回默认并留一条记录；目录没拉到时不判下架', () => {
    assert(!failed(r.removed).length, `下架：${failed(r.removed).join('、')}`)
    assert(!failed(r.cold).length, `冷启动：${failed(r.cold).join('、')}——席位每次重启都会把人的选择冲掉`)
  })

  await test('回到默认', () => {
    assert(!failed(r.reset).length, `回默认：${failed(r.reset).join('、')}`)
  })

  await test('渠道 /model：序号、default、key、id、显示名；认不出来不猜', () => {
    assert(!failed(r.channel).length, `渠道命令：${failed(r.channel).join('、')}`)
  })
}
