/**
 * 席位从入站请求上学「Gateway 现在在哪」。探针在 bot/e2e-gateway-url.mjs（纯函数，要 tsx）。
 *
 * 这条路要解的死结：席位的 GATEWAY_URL 是部署那一刻写死进 bot.env 的，Gateway 换了对外
 * 地址（家里 DHCP 换个租约就够）之后，这台席位彻底哑掉——模型调用、目录拉取、会话上报
 * 全是 fetch failed，而它自己无从知道新地址，因为唯一能告诉它的通道正是它打不出去的
 * 那一条。反过来走：Gateway 每次打进来时顺便报一下自己在哪。
 *
 * 错了都不当场报错，所以这里逐条钉住。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-gateway-url.mjs')

export async function runGatewayUrl({ root, test, assert, log }) {
  log('\n# gateway-url')
  const r = await runProbe(root)

  await test('学到新地址：改写 bot.env，其余各行一个字不动', () => {
    assert(r.rewrite.lineChanged, 'GATEWAY_URL 那一行没换成新地址')
    assert(r.rewrite.oldGone, '旧地址还留在文件里')
    assert(r.rewrite.memory === 'http://192.168.5.40:3080', `内存里还是 ${r.rewrite.memory}`)
    // 这两条挂了 = 席位重启即变砖：没有票和 key，它连 Gateway 的门都进不去，
    // 而那比「地址过期」严重得多——地址过期至少还能靠重新部署救回来。
    assert(r.rewrite.keptToken, 'GATEWAY_TOKEN 被写没了')
    assert(r.rewrite.keptApiKey, 'GATEWAY_API_KEY 被写没了')
    assert(r.rewrite.keptRest, '别的环境变量被写没了')
    assert(r.rewrite.lines === 6, `行数变了：${r.rewrite.lines}，应该还是 6`)
    // 文件里有票和 key，而席位那个 Linux 用户在 noVNC 桌面里能开终端。
    assert(r.rewrite.mode === '600', `权限被放宽成了 ${r.rewrite.mode}`)
    assert(r.rewrite.noTmp, '临时文件留下了——它和 bot.env 同内容，权限却没人管')
  })

  await test('地址没变就不写盘', () => {
    assert(r.same.untouched, '地址一样却还是写了一次盘')
    assert(r.same.memory === 'http://192.168.5.59:3080', '把内存改坏了')
  })

  await test('写不进去时绝不改内存', () => {
    // 这条是整件事最容易做错的一处：先改内存再落盘的话，一次写失败会留下
    // 「这次好了、重启又回去」的间歇故障——而且**再也不会重试**，因为下一次调用
    // 会因为「和内存里的一样」提前返回。
    assert(r.unwritable.memory === 'http://192.168.5.59:3080', '盘没写成，内存却改了')
    assert(r.unwritable.said, '写失败了一声不吭')
  })

  await test('本地开发没有 bot.env：内存也不动', () => {
    assert(r.noFile.memory === 'http://192.168.5.59:3080', '没地方落盘却改了内存')
    assert(r.noFile.said, '没说为什么不改')
  })

  await test('形状不对的一律不认', () => {
    // 带路径、带查询、带用户名口令、非 http(s) —— 都不是一个裸 origin。
    assert(r.junk.allRejected, `${r.junk.n} 种垃圾输入里有被接受的`)
  })

  await test('bot.env 里没有那一行时补一行，不把文件改没', () => {
    assert(r.missingLine.added, '没补上 GATEWAY_URL')
    assert(r.missingLine.keptToken, '补的时候把原有内容冲掉了')
  })

  // ── 远程席位：bot.env 在 root 的 /etc/satuwork/seats/<席位>/ 里，bot 写不动 ──
  // 新地址写 $SATUWORK_HOME/gateway-url。那份文件 terminal 里的子进程也写得动，所以必须
  // 带席位票做的 MAC——不然改一行就能让 bot 下次重启把票和 API Key 送到别人的服务器上。

  await test('远程席位：新地址写进 gateway-url（带 MAC、不含票），重启回来按它起', () => {
    const s = r.seatAdopt
    assert(s.memory === 'http://192.168.5.40:3080', `内存里还是 ${s.memory}`)
    assert(s.wrote, 'gateway-url 没写成 { url, base, mac }')
    assert(!s.hasToken, 'gateway-url 里出现了票')
    assert(s.mode === '600', `权限是 ${s.mode}`)
    assert(s.noBotEnv, '远程席位上又在 SATUWORK_HOME 里造了一份 bot.env')
    assert(s.afterRestart === 'http://192.168.5.40:3080' && s.src === 'override', `重启后是 ${s.afterRestart}（${s.src}）`)
  })

  await test('远程席位：gateway-url 被改过就不认', () => {
    assert(r.seatTampered.memory === 'http://192.168.5.59:3080', `认了被改过的地址：${r.seatTampered.memory}`)
    assert(r.seatTampered.src === 'deployed', r.seatTampered.src)
    assert(r.seatTampered.said, '被改了一声不吭')
  })

  await test('远程席位：重新部署换了地址或换了票，旧覆盖作废', () => {
    assert(r.seatRedeployed.memory === r.seatRedeployed.expect, `重新部署的地址被旧覆盖盖掉了：${r.seatRedeployed.memory}`)
    assert(r.seatRotated.memory === 'http://192.168.5.59:3080', `票换了还认旧 MAC：${r.seatRotated.memory}`)
  })

  await test('远程席位：写不进 gateway-url 时绝不改内存', () => {
    assert(r.seatUnwritable.memory === 'http://192.168.5.59:3080', '盘没写成，内存却改了')
    assert(r.seatUnwritable.said, '写失败了一声不吭')
  })

  await test('不是远程席位：启动时不读 gateway-url', () => {
    assert(r.localIgnores.fileThere, '前提没造出来')
    assert(r.localIgnores.memory === 'http://192.168.5.59:3080' && r.localIgnores.src === 'deployed', '本地 bot 认了 gateway-url')
  })
}
