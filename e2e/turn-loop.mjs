/**
 * 原地打转：同一个调用连着撞同一句报错，这一轮当场停。探针在 bot/e2e-turn-loop.mjs。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-turn-loop.mjs', { env: { GATEWAY_URL: '', GATEWAY_API_KEY: '', SATUWORK_BOT_ID: '' } })

export async function runTurnLoop({ root, test, assert, log }) {
  log('\n# turn-loop')
  let r
  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.same && r.varied && r.unit, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('同一句报错撞 4 次就停，并说清撞的是什么', () => {
    /**
     * 本地实测：skill_manage 不带 name，「缺少 name」原样撞了 50 多次，每一步都按整份上下文
     * 计费。停下来那句话要带上那句报错——人一眼就看得出缺了什么。
     */
    assert(r.same.allRefused, '这一组每次都该是同一句业务拒绝')
    assert(r.same.toolResults === 4, `该在第 4 次停，实为 ${r.same.toolResults}`)
    assert(r.same.reason === 'capped', `收口原因：${r.same.reason}`)
    assert(r.same.closing.includes('probe_open') && r.same.closing.includes('找不到 没有这个文件.txt'), `要说清撞的是什么：${r.same.closing}`)
  })

  await test('报错每次不同不算打转，照常跑到步数硬顶', () => {
    // 它在换着试，不是没听进去；这条拦错了，正经的排查就会被半路掐掉。
    assert(r.varied.toolResults === 8, `该跑满 8 步，实为 ${r.varied.toolResults}`)
    assert(r.varied.closing.includes('单轮上限'), `该是撞步数顶那句话：${r.varied.closing}`)
  })

  await test('判据本身：成功一步、报错换了、一步里有成功的，都从头数', () => {
    const u = r.unit
    assert(u.third.join() === 'false,false,true', `第 3 次该停：${u.third}`)
    assert(!u.resetByOk.includes(true), `中间成功过就从头数：${u.resetByOk}`)
    assert(!u.changed.includes(true), `报错换了就从头数：${u.changed}`)
    assert(!u.mixed.includes(true), `一步里有成功的不算打转：${u.mixed}`)
    assert(u.pipe.join() === 'false,true', `管道层失败（isError）同样算：${u.pipe}`)
    assert(!u.off.includes(true), `上限 0 关掉：${u.off}`)
    assert(u.meta.tool === 'skill_manage' && u.meta.error === '缺少 name' && u.meta.count === 3, `撞的是什么要记得住：${JSON.stringify(u.meta)}`)
  })
}
