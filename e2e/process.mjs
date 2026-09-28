/**
 * terminal / process：前台、后台、以及**关机之后机器上还剩什么**。
 * 探针在 bot/e2e-process.mjs（要 tsx 才 import 得了 .ts）。
 *
 * 这一组和别的不一样：它钉的东西在这台机器上留得下痕迹。一个没杀干净的后台进程会占着
 * 端口和内存活到下次重启，而所有别的信号都是绿的——所以每一条「杀掉了」都是拿
 * `kill(pid, 0)` 问操作系统问出来的，不是读我们自己那本账。
 */
import { runProbe as sharedProbe } from './probe.mjs'

// 比默认那档宽：这一份真起进程、真等后台任务收口。但要**留在用例那道闸以内**，
// 否则两边同时到点，报出来的是笼统的「用例卡住」而不是探针自己那句。
const runProbe = (root) => sharedProbe(root, 'bot/e2e-process.mjs', { timeout: 90_000 })

const all = (obj) => Object.entries(obj).filter(([, v]) => v !== true).map(([k, v]) => `${k}=${JSON.stringify(v)}`)

export async function runProcess({ root, test, assert, log }) {
  log('\n# process')
  let r
  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.foreground && r.shutdown, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('前台：退出码是业务结果，超时按秒算', () => {
    assert(r.foreground.跑得通 === 'hi', `没跑通：${r.foreground.跑得通}`)
    // 退出码非零是模型要看到并自己决定下一步的东西，不是管道故障。
    assert(r.foreground.退出码非零不是管道故障, '非零退出码被当成了管道故障')
    // 单位从毫秒换成了秒。理解错一边，`timeout: 1` 要么是一毫秒要么是十六分钟。
    assert(r.foreground.超时按秒算, 'timeout 不是按秒算的')
    assert(r.foreground.workdir生效, 'workdir 没生效')
  })

  await test('前台：逃出进程组的后代攥着管道，超时和停止照样返回', () => {
    // 以前只等 close：`setsid foo &` 的后代拿着 stdout 不放，这次调用永远不返回，整轮挂死。
    const bad = all(r.escapee || {})
    assert(r.escapee && !bad.length, `这几条不对：${bad.join('、') || '没有结果'}`)
  })

  await test('输出超限：截断，但全文捞得回来', () => {
    // 工具描述里禁止模型自己 `| tail`（管道会把退出码盖掉），那句话只有配上这一条
    // 才站得住：得给它一条把全文捞回来的路。
    const bad = all(r.spill)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('命令产出的文件点得开', () => {
    // 模型用 terminal 造出来的东西（跑脚本生成的报表、curl 下来的附件）以前一颗药丸
    // 都没有：`write_file` 报得出自己写了哪个文件，一条 shell 命令报不出。于是用户
    // 只能听它说一句「文件在工作区里」——而用户手上根本没有那台机器的文件管理器。
    assert(r.produced.报了产出.includes('产出/report.html'), `没报出产出：${JSON.stringify(r.produced.报了产出)}`)
    assert(r.produced.名字是文件名 === 'report.html', `name 不是文件名：${r.produced.名字是文件名}`)
    // 判据是 mtime，不是「跑过一条命令」——一次 `echo` 不该在界面上摆出一排药丸。
    assert(r.produced.只读命令不报, '只读命令也报出了产出')
    // 跑到一半失败的命令留下了什么，恰恰是那时候人最想看的。
    assert(r.produced.失败的命令也报.includes('半截.txt'), `失败的命令没报产出：${JSON.stringify(r.produced.失败的命令也报)}`)
    assert(r.produced.过程痕迹不报, '.satuwork 里的过程痕迹混进了产出')
  })

  await test('产出扫描认的是 mtime，所以别的写入方要先排除掉', () => {
    /**
     * 文件系统只回答「这个文件什么时候被改的」，不回答「谁改的」。同一个工作区里成系统
     * 的另外几个写入方——用户上传（uploads/）、网页抓取（web/）、浏览器下载（browser/）
     * ——各自已经把文件报进了自己那次调用，混进来就是张冠李戴：一条跑二十秒的命令期间
     * 用户传了张发票，发票会挂到那条命令底下，还跟着 details.files 进会话日志。
     */
    const got = r.produced.别人的地盘不算我的
    assert(got.includes('真产出.txt'), `自己写的那个反而没报：${JSON.stringify(got)}`)
    assert(!got.some((p) => p.startsWith('uploads/')), `用户传的附件被算成了命令产出：${JSON.stringify(got)}`)
    assert(!got.some((p) => p.startsWith('web/')), `web_extract 落的原文被算成了命令产出：${JSON.stringify(got)}`)
  })

  await test('摆不下的不闷声吞掉', () => {
    // 以前砍到五个，一声不吭。一条生成十份分章报告的命令，人看到五颗药丸会以为一共
    // 就这五个——而这个仓库在过程截图和「读过的文件」两处都明写着不许这么干。
    assert(r.produced.十个全报.length === 10, `十个报成了 ${r.produced.十个全报.length} 个：${JSON.stringify(r.produced.十个全报)}`)
    // 一次安装 / 构建 / 切分支能改上百个文件，那是过程不是产出，一个都不摆。
    assert(r.produced.批量改动不报, '批量改动也摆了药丸')
    // 但**要说一声**：一颗药丸都没有，和「这次什么都没产出」在屏幕上一模一样。
    assert(r.produced.批量改动说了一声, '批量改动闷声吞掉了，模型无从知道')
    assert(r.produced.不该无缘无故说那句, '正常的一次产出也带上了「改动太多」那句话')
  })

  await test('连着跑二十轮：窗口不往回开，地板也不抬过头', () => {
    /**
     * 上面每一条都只跑一次，而这条窗口只有半毫秒宽——单跑一次是抛硬币，用例会变成随机
     * 红，而随机红的用例等于没有。所以这一条把同一段时序连着压二十轮，并且每轮都在只读
     * 命令**紧挨着**写一个文件：那是「同一个工作区里的另一个写入方」，也是这条不变量真
     * 正要挡的东西，而且它和下一条命令之间只隔着几行 JS，不再指望时序凑巧。
     *
     * 「不往回开」和「不抬过头」是同一根轴的两头，必须一起钉：地板取自 `Date.now()`
     * 就往回开（`Date.now()` 取整、`mtimeMs` 带小数，早于这条命令的写入漏进来）；拿
     * 「往后挪一毫秒」去堵，就换成了抬过头——在时间戳粗一格的文件系统上，命令头几毫秒
     * 里真写下的文件反倒丢了。只钉一头，下次就会被另一头的改法糊弄过去。
     */
    const c = r.连跑
    assert(c && c.轮数 >= 20, `轮数不够，抓不住半毫秒宽的窗口：${JSON.stringify(c)}`)
    assert(c.早先的写入泄漏 === 0, `${c.轮数} 轮里有 ${c.早先的写入泄漏} 轮，只读命令报出了早于它的写入：${JSON.stringify(c.样本)}`)
    assert(c.十个变多 === 0, `${c.轮数} 轮里有 ${c.十个变多} 轮把早先的文件算了进来：${JSON.stringify(c.样本)}`)
    // 少报是另一头：地板抬过了命令自己头几毫秒的写入。
    assert(c.十个变少 === 0 && c.单个没报 === 0, `${c.轮数} 轮里丢了产出（十个变少 ${c.十个变少}、单个没报 ${c.单个没报}）：${JSON.stringify(c.样本)}`)
  })

  await test('后台：立刻返回，poll 只给新输出', () => {
    assert(!all(r.background).length, `起后台不对：${all(r.background).join('、')}`)
    // poll 再给一遍旧输出的话，模型会以为那一步又跑了一次。
    assert(!all(r.poll).length, `poll 不对：${all(r.poll).join('、')}`)
    assert(r.list, 'list 里没有刚起的那个')
    assert(r.prefix, '唯一前缀指不到进程——模型抄长 id 会抄错')
    // 别的会话看不见，也管不着。
    assert(/没有 proc_/.test(r.otherSession), `跨会话够得着别人的进程：${r.otherSession}`)
  })

  await test('wait 停得下来，而进程照旧在跑', () => {
    assert(!all(r.waitTimeout).length, `wait 超时不对：${all(r.waitTimeout).join('、')}`)
    // 停止按钮掐的是这一轮。后台进程存在的意义就是活过这次调用——要停得调 kill。
    assert(!all(r.abortStopsWaitNotProcess).length, `中止语义不对：${all(r.abortStopsWaitNotProcess).join('、')}`)
  })

  await test('kill 杀的是整族，不只是那个 shell', () => {
    assert(r.killTree.杀之前fork出去的活着, '探针没能确认子进程起来了，后面那条断言不作数')
    // 只杀 bash 的话，`sleep 60 &` 这类 fork 出去的会留下来，端口和 CPU 一起占着。
    assert(r.killTree.杀之后整族都没了, 'fork 出去的进程活下来了')
    assert(r.killTree.状态变了, 'kill 之后状态没更新')
    assert(r.killed, 'kill 没报成功')
  })

  await test('并发上限按会话算，拒绝时把清单摆出来', () => {
    const bad = all(r.cap)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('notify_on_complete：进程结束自己来一条，落成 user/message', () => {
    // 不变量 7：进入模型的那句话必须在 JSONL 里，重放才对得上。source 写 process，
    // 否则日志里那句话看起来像用户自己说的。
    // 「自己杀的不通知」也在这一组：kill 是模型刚发起的调用，结果它已经拿到了；照样
    // 通知的话，那一轮要是收了口，send 会为此单独开一轮——用户看到一条没来由的消息，
    // 账上还多一次模型调用。
    const bad = all(r.notify)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('中文输出不出现替换字符', () => {
    // 一个汉字三个字节，chunk 边界切在字符中间时两半各自解码就是两个 �。前台那次最多
    // 是屏幕上花一下，后台那份还会落进 proc/<id>.log，原字节再也捞不回来。
    const bad = all(r.utf8)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('后台日志有上限，log 只读要的那几行、行号不因滚段错位', () => {
    // 以前只增不减：刷屏的 dev server 跑一天能写满盘，log 还整份读进内存。
    const { raw, ...rest } = r.logCap || {}
    const bad = all(rest)
    assert(r.logCap && !bad.length, `这几条不对：${bad.join('、') || '没有结果'}（${JSON.stringify(raw)}）`)
  })

  await test('callId 洗过再拼路径', () => {
    // callId 是 provider 给的，一路透传到落盘那一步。上传文件名和 sessionId 早就走
    // safeName / safeSegment 了，这条新路不该是例外。
    const bad = all(r.callId)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('开机扫掉没主人的后台日志', () => {
    // 删日志靠的是退出后那个三十分钟的定时器，而定时器活在内存里——换一次版、崩一次，
    // 日志就留在盘上再也没有主人。
    assert(r.sweep.过期的删了, '过期的日志没被扫掉，proc/ 会只增不减')
    assert(r.sweep.新的留着, '把还有用的日志一起删了')
  })

  await test('SIGTERM：进程自己退出，而且一个孤儿都不剩', () => {
    // 两件事都要成立。**给 SIGTERM 装监听器就摘掉了 Node 的默认退出**——只杀后台进程
    // 不重发信号的话，进程会一直活到 systemd 那九十秒的硬杀，每次换版白等一分半。
    // 这一条只有拿真信号打一个真进程才测得出来，`process.emit` 是测不出来的。
    assert(r.shutdown.信号之前活着, '探针没能确认子进程起来了，后面两条断言不作数')
    assert(r.shutdown.进程自己退出了, '收到 SIGTERM 之后进程没退出——换一次版要白等 systemd 的停机超时')
    assert(r.shutdown.孤儿也没了, 'SIGTERM 之后后台进程还活着——换一次版就漏一批孤儿')
  })
}
