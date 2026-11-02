/**
 * 补捞的记忆跟着用户消息走：这一轮看得见，下一轮重建出来一字不差。探针在 bot/e2e-turn-recall.mjs。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-turn-recall.mjs', { env: { GATEWAY_URL: '', GATEWAY_API_KEY: '', SATUWORK_BOT_ID: '' } })

export async function runTurnRecall({ root, test, assert, log }) {
  log('\n# turn-recall')
  let r
  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.first && r.next, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('被挤在外面的那条，这一轮补在用户消息末尾，不进系统提示词', () => {
    assert(r.first.system.includes('新近的第 19 条'), '系统提示词里该有最新的那些')
    assert(!r.first.system.includes('Uclub'), '最老那条该被注入上限挤在系统提示词外面')
    assert(r.first.user.includes('给 Uclub 回封邮件') && r.first.user.includes('enxi.liu@uclubgroup.com.sg'), `该补在这条消息里：${r.first.user}`)
    assert(r.first.user.indexOf('给 Uclub 回封邮件') < r.first.user.indexOf('enxi.liu'), '补捞该在正文后面')
  })

  await test('下一轮：重建出来的那条和当时送进去的一字不差', () => {
    // 这一条是整组的重点：差一个字，前缀缓存就从这条消息断开，而且看不出任何异常。
    assert(r.next.sameAsLive, `重建的和当时送进去的不一样：\n当时：${r.first.user}\n重建：${r.next.rebuilt}`)
    assert(!r.next.user.includes('enxi.liu'), '沾不上边的一句不该补捞')
    assert(r.logged[0]?.[0]?.id === 'old' && r.logged[1] === null, `日志里的 recall 不对：${JSON.stringify(r.logged)}`)
  })
}
