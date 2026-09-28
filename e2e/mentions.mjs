/**
 * `@` 点名与排队。探针在 bot/e2e-mentions.mjs。
 *
 * 这一组守的是四条不能塌的线：
 *
 *   1. **落盘是结构，进模型是话。** JSONL 里是 `mention` 块，模型收到的是一行
 *      `[本轮指定：…]`。反过来（把那句话写进正文）就再也分不清「用户点名了这把连接」
 *      和「用户碰巧打了这几个字」。
 *   2. **`mentionOnly` 平时不在工具表里。** 个人邮箱得是「我点名了你才能碰」。
 *   3. **点名是点名，不是限定。** 别的工具一个都不能少，否则「@Gmail 看邮件，然后在
 *      Notion 建个页面」就成了半个功能。
 *   4. **带 `@` 的消息排队，不插话。** steering 插进的那一轮工具表早就定了，而 `@` 的
 *      全部意义就是改工具表。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-mentions.mjs', { env: { GATEWAY_URL: '', GATEWAY_API_KEY: '', SATUWORK_BOT_ID: '' } })

export async function runMentions({ root, test, assert, log }) {
  log('\n# mentions')
  let r
  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.plain && r.mentioned && r.jsonl && r.queue && r.window && r.cancelKinds, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('不点名：「仅 @ 时可用」的那把不在工具表里', () => {
    assert(r.plain.有默认那把, '普通连接的工具应该在')
    assert(r.plain.没有仅点名那把, 'mentionOnly 的进了默认工具表，那这个开关就是摆设')
    assert(r.plain.有别的工具, '别的工具无端少了')
  })

  await test('点名之后：它进来了，排最前，别的一个没少', () => {
    assert(r.mentioned.仅点名那把进来了, '点名了还是没进工具表')
    assert(r.mentioned.别的工具没被拿掉, '点名成了过滤——「@Gmail 看邮件再去 Notion 建页」会废掉')
    assert(r.mentioned.被点的排最前, '没顶到最前。工具表一长，模型就在前几个里选，点了等于没点')
    assert(r.mentioned.进模型的是一句话, '模型没收到 [本轮指定：…]')
    assert(r.mentioned.正文还在, '点名把正文挤掉了')
  })

  await test('落盘是结构，不是那句话', () => {
    assert(r.jsonl['有 mention 块'], 'JSONL 里没有 mention 块')
    assert(r.jsonl['块里带 label'], 'mention 块没带 label，界面翻历史时药丸就是空的')
    assert(r.jsonl.正文另存一块, '正文没有独立成块')
    assert(r.jsonl.没把那句话写进正文, '把 [本轮指定：…] 写进了正文——那是给模型的渲染，不是原始记录')
    assert(r.jsonl.版本号 === r.jsonl.当前版本, `会话版本号该是 v${r.jsonl.当前版本}，实为 v${r.jsonl.版本号}`)
    assert(r.jsonl.当前版本 === 5, `加了 mention 块就该升到 v5，实为 v${r.jsonl.当前版本}`)
  })

  await test('席位忙不忙只认在跑的轮次——孤儿排队行不许把它永远钉住', () => {
    // 一条在 turn 跑到一半被杀掉时留下的排队消息（队列落盘，重启后还在），必须不让
    // 这个席位自报忙：管家的换版闸认的就是 running（见 manager/src/seats.ts 的排空），
    // 认了 queued 的话这台席位从此永远 409，再也升不上去——而那时候拦下重启一件东西
    // 也保护不了，根本没有 turn 在跑，队列本来就不会动。
    assert(r.busyGate.盘上确实还排着一条, `前置没成立：${JSON.stringify(r.busyGate)}`)
    assert(r.busyGate.没有轮次在跑, `只剩排队消息时还自报在跑：${JSON.stringify(r.busyGate)}`)
    assert(r.busyGate.queued照旧报得出来, `queued 不报了，查孤儿行就没有线索了：${JSON.stringify(r.busyGate)}`)
  })

  await test('换版静默：不开新的一轮，放开之后立刻恢复，TTL 夹得住', () => {
    // 排空等到「此刻没人在跑」之后，到真的 systemctl restart 之间还有几秒（拉包、
    // 解包、rsync）。没有这道闸，人在那几秒里发一句照样被砍断，而排空看上去是成功的。
    assert(r.quiet.静默期回绝了新一轮, `静默期还在开新一轮：${JSON.stringify(r.quiet)}`)
    assert(r.quiet.回绝之后没留下半个轮次, `回绝了却留下了半个轮次：${JSON.stringify(r.quiet)}`)
    assert(r.quiet.放开之后又接活了, `放开之后还不接活——这道闸只该管换版那几秒`)
    assert(r.quiet.上限夹得住, `TTL 没夹住：管家半路挂了，这台席位就成了一块永远不接活的砖`)
  })

  await test('上一轮在跑：带 @ 的排队，跑完自己接上', () => {
    assert(r.queue.在跑, '探针没能把一轮卡住，后面的断言不成立')
    assert(r.queue.排进去了 && r.queue.能排两条, `排队没生效：${JSON.stringify(r.queue)}`)
    assert(r.queue.先进的排在前, '队列不是先进先出')
    assert(r.queue.取消得掉 && r.queue.取消之后剩一条, '取消没生效')
    assert(r.queue.取消不存在的会说没这条, '取消一个不存在的 id 应该如实说「没这条」')
    assert(r.queue.队列清空了, '上一轮收口之后队列没接上')
    assert(r.queue.排队那条真的跑了, '排队的消息最后没跑')
    assert(r.queue.排队那条带着点名, '排队的那条跑起来时，它带的 @ 丢了')
  })

  await test('出队之后、agent 建出来之前，这条会话仍然算在跑', () => {
    /**
     * runTurn 走到 live.set 之前有好几个 await。那期间 isRunning() 要是 false，
     * 同一条会话会被开出第二轮并发 agent——事件交错写进同一份 JSONL，用量记两遍。
     * 探针把 sessions.events 卡住，正好停在那个窗口上。
     */
    assert(r.window.出队之后仍然算在跑, 'drainQueue 没占住 starting，这里能挤进第二轮并发 turn')
  })

  await test('队列里一条跑失败，后面的照跑', () => {
    // 一条失败就收工的话，后面几条既不跑也不清，dock 上一直挂着，而没有任何东西
    // 会再来叫醒队列——只能等用户手动再发一条。
    assert(r.keepGoing.失败那条不挡后面的, '前一条失败把后面的堵死了')
    assert(r.keepGoing.队列清空了, '失败之后队列没清干净')
  })

  await test('取消分得清「没这条」和「已经开跑」', () => {
    // 合成一句「已经开始执行」的话，两个标签页各点一次取消，后点的那个会以为自己
    // 拦不住一条其实早就被取消掉的消息。
    assert(r.cancelKinds.没这条, '不存在的 id 该说「没这条」')
    assert(r.cancelKinds.取消成功, '正常取消失败了')
    assert(r.cancelKinds.取消过的再取消还是没这条, '取消过的又说成「已经开跑」')
    assert(r.cancelKinds.已经开跑, '已经出队开跑的该说「已经开跑」，不能说没这条')
  })

  await test('点名了却没工具：先补拉一次目录，补回来了就当无事发生', () => {
    // 最常见的一种是「刚连上就来用」：连接是几十秒前在浏览器里授权的，而席位一分钟
    // 才探一次目录。等下一轮探针的话，用户得到的是「我没有邮件工具」，然后他会以为
    // 授权失败，回去把连接重做一遍。
    assert(r.late.补拉了一次, '点名的连接没工具时没有补拉目录')
    assert(r.late.工具补回来了, '补拉之后工具还是没进这一轮的工具表')
    assert(r.late.不用再跟模型解释, '工具明明有了，还在跟模型说「没挂上」')
  })

  await test('补拉了还是没有：把实情说给模型听，别让它自己编替代方案', () => {
    /**
     * 不说这一句的代价是模型开始编。线上真发生过：用户 @Gmail (default) 说「查看
     * 邮件」，那把连接的工具没挂上，模型一无所知，于是自己找了个替代方案——「你指定的
     * Gmail 应该是指用桌面浏览器操作 Gmail」，接着去开虚拟桌面里的 Chrome。用户看到
     * 的是一堆莫名其妙的 bash 调用，而真正的问题一个字都没提到。
     */
    assert(r.gap.也补拉了一次, '缺工具时没有补拉目录')
    assert(r.gap.跟模型说清楚了, '点名的连接没挂上，模型那边一无所知')
    assert(r.gap.点了名的那把写出来了, '没说清是哪一把没挂上')
    assert(r.gap.这一轮照样跑, '为了这件事把整轮拦掉了——别的工具还是该给')
  })

  await test('「是不是点名调的」这个标记，绝不许把工具调用弄失败', () => {
    /**
     * 目录插件不能 inject agents（agents 那边 inject 了 catalog，绕一条环回来两边都起
     * 不来）。原来写成 `ctx.agents?.mentionedIn?.()`，以为 `?.` 兜得住——可 cordis 的
     * 守卫是在**取属性那一刻**抛的，`?.` 挡的是取到之后的 null。线上的表现是 Gmail 的
     * 每一次调用都返回 `cannot get property "agents" without inject`：一个流水上的附加
     * 标记，把整把工具打死了，而模型只能照着这句英文告诉用户「MCP 配置有问题」。
     */
    assert(r.viaMention.一次都没抛出来, 'ctx.agents 抛出来的异常没被接住')
    /**
     * **答不上来时给 undefined，不是 false。**
     *
     * 这条以前断言的是 false（「取不到就当没点名」）。后来 Gateway 拿这个标记去强制
     * 「仅 @ 时可用」的连接（routes/mcp.ts），两个值就有了完全不同的后果：false 是
     * 「我看过了，人没点名」，会让那次调用被服务端拒掉；而上面那次故障里席位其实
     * 什么都没看到。报 false 等于替用户说他没点名——用户明明 `@` 了自己的邮箱，
     * 却每次都被回一句「这一轮没有点名它」，做什么都没用。
     */
    assert(r.viaMention.取不到时是undefined, '取不到 agents 时报了 false，等于替用户说他没点名')
    assert(r.viaMention.reflect自己炸了也不许抛, 'reflect 出问题时还是会抛')
    assert(r.viaMention.没有reflect也不许抛, '没有 reflect 的 ctx 会把调用弄失败')
    assert(r.viaMention.点了名的照样认得出, '兜住异常的同时把功能也兜没了')
    assert(r.viaMention.没点那台不算, '没点名的服务器被算成点了名')
  })

  await test('开轮那几秒里按停止：停得下来，这一轮以 aborted 收口，模型一次不调', () => {
    // 以前 abort 只看 live：重拉目录、同步压缩那几秒里按停止回 false，然后整轮照跑。
    const bad = Object.entries(r.abortStarting || {}).filter(([, v]) => v !== true).map(([k]) => k)
    assert(r.abortStarting && !bad.length, `这几条不对：${bad.join('、') || '没有结果'}`)
  })

  await test('取消掉的那条一个字都不留在日志里', () => {
    // 队列不写 JSONL：被取消的消息从没进过模型，写进去会让重放凭空多一条用户消息。
    assert(r.cancelled.取消的那条没进日志, '取消掉的消息进了 JSONL')
  })
}
