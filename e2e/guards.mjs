/**
 * 行为边界：模版上那三个开关的**执行点**。探针在 bot/e2e-guards.mjs。
 *
 * 为什么值得单开一个套件：这一层坏了**不报错**。开关照样存、界面照样画着开着的样子，
 * 而工具照跑——日志、状态码、类型检查全都干干净净。只有对着一条真的调用跑一遍，
 * 才看得出「拦」这件事到底有没有发生。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-guards.mjs', { timeout: 60_000 })

const all = (obj) => Object.entries(obj).filter(([, v]) => v !== true).map(([k]) => k)

export async function runGuards({ root, test, assert, log }) {
  log('\n# guards')
  const r = await runProbe(root)

  await test('三条开关开着：该放的放、该拦的拦', () => {
    const bad = all(r.onGuards)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('被拦的调用一次都没跑到工具里', () => {
    // 这条才是重点。「返回了一句拒绝」和「那封邮件没发出去」是两件事，
    // 而只有后者算数——拦截必须发生在 execute 之前，不是之后的道歉。
    assert(r.blockedNeverRan.mcp_b_send_mail === 0, `没授权的 MCP 还是跑了 ${r.blockedNeverRan.mcp_b_send_mail} 次`)
    assert(r.blockedNeverRan.mystery === 0, `没标注风险的工具还是跑了 ${r.blockedNeverRan.mystery} 次`)
    assert(r.terminalRuns === 2, `terminal 跑的次数不对（应当只有 ls 和 git status 两次）：${r.terminalRuns}`)
  })

  await test('拒绝的那句话说得出是什么挡的、下一步能干什么', () => {
    // 一句没有出路的拒绝，模型多半会原样再调一次，然后在步数硬顶里空转到底。
    assert(r.deniedText.includes('行为边界'), `没说是谁挡的：${r.deniedText}`)
    assert(r.deniedText.includes('模版'), `没给出路：${r.deniedText}`)
  })

  await test('terminal：本地命令照跑，联网的挡下', () => {
    const bad = all(r.terminal)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('开关关掉就该真的放行', () => {
    const bad = all(r.offGuards)
    assert(!bad.length, `关了还在拦：${bad.join('、')}`)
  })

  await test('认不出来的一律按拦处理', () => {
    // 老 Gateway 没下发 guards、名册里没有这颗 Bot、会话读不到——这三种最该保守的
    // 情况，早先版本走的是同一条「mcps 是 undefined 就放行」的分支，全部一路放行。
    const bad = all(r.failClosed)
    assert(!bad.length, `这几条没有 fail closed：${bad.join('、')}`)
  })

  await test('高风险确认：调用真的停在执行前等人拍板', () => {
    const a = r.approvals
    // 「等的时候没跑」是这一条的全部意义。返回一句「需要确认」然后照跑，
    // 和没有这个开关是一样的。
    assert(a.等的时候没跑, '等确认的时候工具已经跑了')
    assert(a.发了pending事件 && a.队列里能查到, '没有一条能让界面画出卡片的 pending')
    // 「Bot 想调用 send_email，批准吗」本身没有信息量——人要批的是「发给谁、写了什么」。
    assert(a.卡片上有参数, '卡片上没有参数')
    assert(a.卡片上有理由, '卡片上没说为什么要确认')
    assert(a.批准返回ok && a.批准后真的跑了, '批准之后那次调用没继续跑下去')
    assert(a.队列已清空, '批准完了还挂在待办里')
  })

  await test('拒绝 / 超时 / 停止：三种都不许放行，而且分开说', () => {
    const a = r.approvals
    assert(a.拒绝后没跑, '拒绝了还是跑了')
    assert(a.拒绝的话说清了别重试, '拒绝的措辞没让模型换个做法')
    assert(a.重复点会说已结束, '重复点击被当成一次新的批准')
    // 到点按不执行处理。反过来（超时即批准）意味着人只要离开工位，边界就自动消失。
    assert(a.超时没跑 && a.超时说的是没人回应, '超时的处理不对')
    assert(a.停止后没跑 && a.停止说的是被停止, '点了停止之后确认没有当场断掉')
  })

  await test('「这一轮都批准」只管这一轮：轮末清掉，下一轮重新问', () => {
    /**
     * **这条是这颗按钮的全部意义所在。**
     *
     * 一个 Bot 一辈子只有一条会话（席位的 ensureSession 有就复用），席位上的 bot 又是
     * 常驻进程——按会话记的放行名单等于「这台机器上这把工具从此不再问」，可能一连几周。
     * 而按钮上写的是「这一轮」，人点它时想的是「我让它发三封信，别问我三遍」。
     */
    assert(r.approvals.轮末清掉了名单, '放行名单跨过了轮末——那颗按钮实际给的是永久通行证')
    assert(r.approvals.下一轮重新问, '下一轮没有重新问')
  })

  await test('「这一轮别再试」：之后连卡片都不弹，直接挡', () => {
    const a = r.approvals
    /**
     * 只有「拒绝」的话，模型下一步换个措辞再调一遍同样的东西，人得一次次点——而每一次
     * 都长得差不多。这颗按钮把这一轮的这把工具关掉。
     */
    assert(a.拒绝并拦停_第一次没跑 && a.拦停名单里有它, '拒绝并拦停没生效')
    assert(a.再试不弹卡片, '拦停之后还在弹卡片问人')
    assert(a.再试也没跑, '拦停之后工具还是跑了')
    // 不说清楚是「这一轮」、不给出路的话，它只会换个说法再撞一次。
    assert(a.话里说了这一轮, '给模型的话没说清范围，也没给出路')
    assert(a.留痕说了没有再问, '自动挡下的那几次在日志里看不出是「没有再问」')
    // 和放行名单同生共死：轮末一起清，下一句话重新开始。
    assert(a.轮末清掉了拦停名单 && a.下一轮又会问, '拦停跨过了轮末')
  })

  await test('这一轮之内不再重复问，而且日志上留得下出处', () => {
    assert(r.approvals.这一轮内不再问, '批过一次还在问')
    assert(r.approvals.授权名单里有它, '这一轮的放行名单没记上')
    // 少了这两条，之后那些不再弹卡片的调用在日志里就是一串没有来由的 approved，
    // 而「为什么这次没问我」正是事后翻记录要问的。
    assert(r.approvals.终态事件带范围 && r.approvals.只批一次的也标了范围, '终态事件没记下批准的范围')
    assert(r.approvals.放行的理由写了出处, '靠本会话授权放行的那次，理由里没写出处')
  })

  await test('terminal 按命令判要不要确认，不按它那份最坏情况的 risk', () => {
    // terminal 的 risk 是并集（写 + 毁 + 外联）。照并集判的话每条 ls 都要弹卡片，
    // 人会在第三次之后学会闭眼点批准——那时候这个开关就真的没用了。
    assert(r.approvals.普通命令不问, '普通命令也在弹确认')
    assert(r.approvals.递归删要问, 'rm -rf 没有要求确认')
    assert(r.approvals.递归删被拒后没跑, '拒绝之后命令还是跑了')
  })

  await test('席位桌面：窗口里的命令和 terminal 同一套判据，模版关了整把拒', () => {
    const bad = all(r.desktop)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
    // 空终端、htop 两次；curl 被拦、关了能力的那颗都不该跑到工具里。
    assert(r.desktopTerminalRuns === 2, `desktop_terminal 跑的次数不对：${r.desktopTerminalRuns}`)
    assert(r.desktopOffText.includes('Bot 设置'), `关了能力的那句话没给出路：${r.desktopOffText}`)
    assert(r.approvals.桌面空终端不问, '开一个空终端也在弹确认')
    assert(r.approvals.桌面终端递归删要问, '桌面终端里的 rm -rf 没有要求确认')
    assert(r.approvals.桌面终端递归删被拒后没跑, '拒绝之后桌面终端还是开了')
  })

  await test('terminal 的「这一轮都批准」只放行同一条命令', () => {
    const a = r.approvals
    assert(a.命令放行_第一次要问, 'rm -f 没有要求确认')
    assert(a.命令放行_同一条不再问, '批过的同一条命令还在问（或没跑）')
    assert(a.命令放行_名单里不是整把工具, '放行名单记成了整把 terminal')
    assert(a.命令放行_别的命令还要问, '批了 rm -f build.log 之后，rm -rf 别的路径没再弹卡')
    assert(a.命令放行_别的命令没跑, '没批的那条命令还是跑了')
  })

  await test('个人敏感信息：出站方向真的被拦下', () => {
    const p = r.pii
    assert(p.带身份证被拦 && p.没跑到工具里, '带身份证的调用还是发出去了')
    assert(p.带手机号被拦 && p.带银行卡被拦, '手机号或银行卡没拦住')
    assert(p.说清了是哪一类, '拒绝的话没说是哪一类敏感信息')
    // 拒绝的那句话会进模型上下文、会话日志和审计。把刚拦下来的号码抄进去，
    // 等于挡了一道门、又从窗户递出去。
    assert(p.没有把号码抄回去, '把拦下来的号码原样抄回给模型了')
    assert(p.干净的参数放行, '干净的参数也被拦了')
    assert(p.本地写不受影响, '这条边界说的是「不外发」，不该管本地写')
  })

  await test('敏感信息的识别带校验位，不是纯正则', () => {
    const s = r.piiScan
    assert(s.真身份证.includes('身份证号') && !s.校验位错的身份证.length, '身份证没走校验位')
    assert(s.真卡号.includes('银行卡号') && !s.过不了Luhn的长号.length, '银行卡没走 Luhn')
    // 这三条是「误伤一次，用户就学会把开关关掉」的那几种。
    // 18 位正好是身份证候选的长度。候选和「验过的」混在一个数组里的话，18 位的卡号
    // 会先被身份证的正则捞走、校验位一算不是、又被当成「已经认过」跳掉——Luhn 根本
    // 跑不到，于是**唯独 18 位的卡号一张都拦不住**。
    assert(s.十八位卡号.includes('银行卡号'), '18 位银行卡号没认出来')
    assert(
      s.十八位的真身份证只算身份证.join() === '身份证号',
      `真身份证被重复归类：${s.十八位的真身份证只算身份证.join('、')}`,
    )
    assert(!s.毫秒时间戳.length, '毫秒时间戳被当成了卡号')
    assert(!s.订单号.length, '订单号被当成了证件号')
    assert(!s.座机不算.length, '座机号被当成了手机号')
    // 邮箱有意不算：算进去的话，发邮件、查联系人这类连接器整个不能用了。
    assert(!s.邮箱不算.length, '邮箱被算成了敏感信息')
  })

  await test('升级人工：撞墙三次就该交出去，而且留痕', () => {
    const e = r.escalate
    assert(e.前两次只是拦, '第一次撞墙就喊转人工，太早了')
    assert(e.第三次改口转人工, '连着撞三次还在让它继续重试')
    assert(e.自动升级留了记录 && e.转人工留了记录, '转人工没有留下记录')
    assert(e.有转人工的工具, 'escalate_to_human 没注册')
    // 转人工是模型撞墙之后唯一的出口，它自己不能被任何一条边界挡住。
    assert(e.转人工本身不被拦, '转人工这把工具自己被边界挡了')
  })

  await test('每次拦截都在会话日志里留下一条 tool/policy', () => {
    assert(r.record.条数 > 0, '一条都没留')
    assert(r.record.第一条 && r.record.第一条.guard === 'no-external', `第一条不对：${JSON.stringify(r.record.第一条)}`)
    assert(r.record.第一条.outcome === 'blocked', `outcome 不对：${r.record.第一条.outcome}`)
    // 审计那一屏问的是「拦了什么、为什么」，两样都得能从日志重建。
    assert(r.record.都带上了工具名 && r.record.都带上了理由, '记录里缺工具名或理由')
  })

  await test('命令扫描：认名字，不认花样', () => {
    assert(r.shell.curl === 'curl' && r.shell.绝对路径的curl === 'curl', '直白的 curl 都没认出来')
    assert(r.shell.环境变量前缀 === 'curl', '加个环境变量前缀就绕过去了')
    assert(r.shell.git状态 === null && r.shell.npm跑脚本 === null, '把本地用法也拦了')
    assert(r.shell.git克隆 === 'git clone' && r.shell.npm安装 === 'npm install', '联网子命令没认出来')
    assert(r.shell.内联python === 'python3 -c', '内联解释器里的联网代码没认出来')
    assert(r.shell.解析不出来不拦 === null, '参数不是合法 JSON 时不该由边界来报错')
  })

  await test('命令扫描：交给另一个 shell 跑的那一段也要展开', () => {
    // 只看每段第一个词的话，`bash -c "curl …"` 的头是 bash，两张表里都没有它，
    // 于是整条命令一路放行——而这不是绕法，是模型要用 shell 语法时自己写出来的形状。
    assert(r.shell.嵌套bash === 'curl', 'bash -c 里的 curl 没认出来')
    assert(r.shell.嵌套sh === 'wget', 'sh -c 里的 wget 没认出来')
    assert(r.shell.组合标志的zsh === 'curl', '-lc 这种组合标志没认出来')
    assert(r.shell.eval === 'curl', 'eval 里的 curl 没认出来')
    assert(r.destructive.嵌套的递归删 === 'rm -rf', 'bash -c 里的 rm -rf 没要求确认')
    assert(r.destructive.嵌套的强制推送 === 'git push', 'sh -c 里的强制推送没要求确认')
    assert(r.destructive.普通删不算 === null && r.destructive.ls不算 === null, '把日常命令也拦成毁东西的了')
  })

  await test('子命令前面垫着带值的标志时照样认得出', () => {
    // `git -C /repo push`、`npm --prefix ./app install` 比裸写还常见；
    // 「第一个不以 - 开头的词」拿到的是那个路径，子命令就永远匹配不上。
    assert(r.shell.git带C === 'git push', 'git -C 之后的 push 没认出来')
    assert(r.shell.npm带prefix === 'npm install', 'npm --prefix 之后的 install 没认出来')
    // 反过来也不能过头：扫遍全部参数找关键字会把这种查询也拦下来。
    assert(r.shell.git日志里搜push === null, 'git log --grep push 被当成了推送')
  })

  await test('模型自己会写的几种 shell 形状也切得开', () => {
    // 单个 &、子 shell 括号、命令组花括号、if / ! 关键字、`env -i`：文档说扫描只是
    // 「挡顺手」，但这几种是模型日常就会写的，漏了等于没挡。
    assert(r.shell.单个与号 === 'curl', '`a & curl` 没认出来')
    assert(r.shell.子shell括号 === 'curl', '`(curl …)` 没认出来')
    assert(r.shell.命令组花括号 === 'curl', '`{ curl …; }` 没认出来')
    assert(r.shell.套在if里 === 'curl', '`if curl …; then` 没认出来')
    assert(r.shell.取反 === 'curl', '`! curl …` 没认出来')
    assert(r.shell.env空环境 === 'curl', '`env -i curl …` 把 -i 当成了命令')
    assert(r.destructive.短写的强制推送 === 'git push', '`git push -f` 没要求确认')
    assert(r.destructive.强制推送加lease === 'git push', '`--force-with-lease` 没要求确认')
    assert(r.destructive.followTags不算强制 === null, '`--follow-tags` 被当成了强制推送')
  })

  await test('定制审批：发信这一类认得出来，字段摆得开', () => {
    const f = r.form
    // 连接器工具装不下时会收进 SW_RUN，真正的工具名跑到参数里。不剥这层壳，卡片上写的
    // 是「mcp_a_sw_run 会往外部系统写入」——人连自己在批什么都看不出来。
    assert(f.剥得开元工具的壳 === 'GMAIL_SEND_EMAIL', `壳没剥开：${f.剥得开元工具的壳}`)
    assert(f.认出是发信 === 'email', `没认出是发信：${f.认出是发信}`)
    assert(f.正文的路径 === 'args.body', `套了壳的字段路径要带前缀：${f.正文的路径}`)
    assert(f.没套壳的直接认 === 'body', `没套壳的路径不该带前缀：${f.没套壳的直接认}`)
    assert(f.正文可改 && f.主题可改, '正文或主题不让改，那这张卡就只剩「点一下」')
    // 能改收件人的话，「审一眼要发出去的东西」就变成了「在这儿写封信」。
    assert(f.收件人不可改, '收件人被做成可改的了')
    assert(f.其它参数也摆出来, '别的参数被藏起来了——人会以为自己看到了这封信的全部')
    assert(!f.查邮件不算发信 && f.发信算, '发信的判据只看名字里有没有 mail')
    assert(f.不是邮件的退回通用卡 === 'generic', '认不出的没退回通用卡')
  })

  await test('子代理的高风险确认：卡片开在主会话上，人点得动，批过的这一轮不再问', () => {
    const d = r.delegation
    // 开在子会话上等于永远没人点：界面上那条会话根本没有入口，五分钟后按拒绝收口，
    // 而「把这批对账单发出去」这类活就整个委派不了（docs/delegation.md §6.2）。
    assert(d.卡片开在主会话上 && d.子会话上不开卡片, '子代理的确认卡没落在主会话上')
    // 不说出处的话，人看到的是一次凭空出现的发信确认——而他刚才只说了一句「收个尾」。
    assert(d.卡片说清了出处, '卡片上没写这次确认来自哪个子任务')
    assert(d.队列按主会话查得到 && d.主会话id点得动, '界面那一跳带的是主会话 id，却点不动')
    // 换的只是事件落在哪，等的仍然是那次**真调用**——不是「告诉模型可以了让它再调一遍」。
    assert(d.等的时候没跑 && d.批准后子代理那次真的跑了, '批准之后子代理那次调用没有继续跑下去')
    // 子代理整个活在主代理这一轮里，所以「这一轮都批准」要跨得过主子边界。
    assert(d.主会话批过这一轮子代理不再问, '主代理批过的这一轮，子代理又问了一遍')
    assert(d.子任务收口不清主会话名单, '子任务的 turn/end 把主会话这一轮的放行名单清掉了')
    assert(d.主轮收口才清, '主轮收口之后放行名单还在——那就是永久通行证')
  })

  await test('delegate_task 本身不该被边界拦：它不出席位', () => {
    const d = r.delegateRisk
    /**
     * 上线当天就是这儿出的事：标成 external + write 之后，开着「不碰未授权外部系统」
     * 的 Bot **一次都派不出去**，而拒绝话术还把人引去模版里加授权——那儿根本没有它。
     */
    assert(d.外发闸不拦它 && d.外发闸下跑得起来, 'delegate_task 被外发闸挡住了')
    // 「读一遍日志找原因」这种纯只读的委派也弹卡，就是把同一件事算了两遍。
    assert(d.不弹确认卡 && d.高风险闸下跑得起来, '每一次委派都要人点一下头')
  })

  await test('子代理拿不到的两类工具：转人工，和没租到的浏览器', () => {
    const d = r.delegation
    // 子代理面前没有人：一张单开在子会话上没人看得见，人处理完交还时那条会话早收口了。
    assert(d.子代理调不了转人工, '子代理调得动 escalate_to_human')
    // 拒绝必须给出路，否则它会一直换写法重试，把步数耗光。
    assert(d.拒绝的话给了出路, '拦下来了，但没告诉它该怎么办')
    assert(d.主代理照旧调得了, '拦的应该是子会话，不是这把工具')
    // 一台席位一颗浏览器、一块员工正看着的屏。租约按资源名发，不按工具名前缀判。
    assert(d.没租到浏览器就调不了, '没拿到 browser 租约的子任务照样驱动了浏览器')
    assert(d.没租到桌面就调不了, '没拿到 desktop 租约的子任务照样在桌面上开了窗口')
  })

  await test('在卡片上改过的内容，真的是发出去的那一份', () => {
    const e = r.edits
    assert(e.卡片上带着表单, 'pending 事件里没有表单，界面画不出定制卡')
    // 这一条是整件事的重点：改的必须是**真正要执行的那份参数**，不是改个样子。
    assert(e.改过的正文真的发出去了, '工具收到的还是模型起草的那一版')
    assert(e.只读的收件人没被改, '只读的字段被浏览器送来的值改掉了')
    assert(e.表单外的键一概不收, '表单里没有的键也被写进了参数')
    assert(e.别的参数原样留着, '改一格把别的参数带没了')
    assert(e.终态事件记了改过哪几格 === '正文', `没记下改过哪几格：${e.终态事件记了改过哪几格}`)
    // 日志落原文的话，记录上写着模型起草的那封信，而实际发出去的是另一封。
    assert(e.终态事件里是改后的那份, '日志里留的还是改之前的参数')
    assert(e.留痕的理由写了改过, 'tool/policy 的理由里没说这次改过')
    // 「这一轮都批准」= 后面同样的调用不用再问，而后面那些带的是模型自己写的内容。
    assert(e.改过就不给顺带放行, '改过的这一次顺带把后面几次也放行了')
    assert(e.理由说的是真工具, `卡片上那句话还在说壳的名字：${e.理由说的是真工具}`)
  })

  await test('浏览器：没开这项能力就调不通，白名单外的站点拦下', () => {
    // 「本机自建的说得清为什么」那条：那种 Bot 压根没有公司模版，回一句「模版里没有开」
    // 等于让人去一个不存在的地方找开关——而它只在本地开发时出现，正是最需要话说清楚的场合。
    const bad = all(r.browser)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
    assert(r.browserBlockedRuns === 9, `被拦的导航还是跑了（放行的应当只有 9 次）：${r.browserBlockedRuns}`)
  })

  await test('浏览器：通配符按标签配，配上了连子域一起算', () => {
    /**
     * 一条规则贯穿所有写法：`*` 顶一段标签之内的字符（不跨点），配上了就连子域一起算。
     * 于是 `*.example.com` 是「至少一层子域」，`example.com` 是「它自己和所有子域」，
     * 差别在**要不要主站**，不在层数——这比「带 * 的按字面配」好解释，也少一处例外。
     *
     * `example.*`（后缀放开）和 `*.*`（全部放开）都收：**开多宽是管理员的决定**。
     */
    const bad = all(r.browserWildcard)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('浏览器：名单开到 *.* 也拦得住回环和内网', () => {
    /**
     * **这条是整组里最要紧的一个。**
     *
     * 白名单管的是「能去哪些外部站点」，硬黑名单管的是「能不能回头打自己」——后者跑在
     * 前者**之前**，任何配置都关不掉。所以 `*.*` 放开的是整个公网，不是这台机器：
     * 席位上听着 bot 口（3200+N）、CDP 口（9222+N）和管家的口。
     *
     * 少了这条断言，哪天有人把两层判据合成一层，界面上看不出任何变化，而一个填了
     * `*.*` 的公司就等于把 Bot 的手接到了它自己的接口上。
     */
    const bad = all(r.browserAllStillBlocked)
    assert(!bad.length, `开到最大之后这几条也跟着松了：${bad.join('、')}`)
  })

  await test('浏览器：回环、内网、非 http 一律拦，关掉开关也拦', () => {
    /**
     * 这条是整组里最重要的一个。
     *
     * 硬黑名单防的不是「越权访问未授权的外部系统」——那是一条管理员可以关掉的开关；
     * 它防的是**用浏览器回头打自己**：席位上听着 bot 口（3200+N）、CDP 口（9222+N）和
     * 管家的口。挂在那条开关底下的话，管理员为了让 Bot 去个名单外的站点顺手一关，
     * 就把「Bot 能给自己发指令」一起放开了，而界面上没有任何东西会提示这件事。
     */
    const bad = all(r.browserHard)
    assert(!bad.length, `硬黑名单漏了：${bad.join('、')}`)
    const still = all(r.browserHardStaysOn)
    assert(!still.length, `关掉 no-external 之后这几条也跟着松了：${still.join('、')}`)
  })

  await test('浏览器：只读的那几把也走白名单', () => {
    // 把一张登录后的页面读进模型，正是这条边界最该管的动作，不是最不该管的。
    const bad = all(r.browserRead)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('浏览器：认不出来的元素要问，不是放行', () => {
    /**
     * 先写的是「没名字就放行」，那是个真洞：企业后台里的删除按钮常常只有一个垃圾桶
     * 图标，既没有文字也没有 aria-label，快照里就是 `- button "" [@e12]`。照那条规则，
     * 一次不可逆的删除**一张卡片都不会弹**，而 tool/policy 里也不会留下任何东西。
     */
    const a = r.browserApproval
    assert(a.没名字的按钮要问, '只有图标的按钮被放行了')
    assert(a.没名字也没角色的要问, '连角色都认不出来的元素被放行了')
    assert(a.没名字的链接不问, '没文字的链接也弹卡，那是噪音')
  })

  await test('浏览器：放行时把允许的站点推给服务，事后补记漏掉的写', () => {
    /**
     * 两件事都在策略之外，但只有策略知道该什么时候做：
     *
     *  1. 策略只判「动手之前停在哪一页」，而一次调用当中页面还会跳（302、点开新标签页、
     *     页内脚本自己走）。名单推下去，服务在读回内容之前用同一套判据再判一次。
     *  2. 提交判据是启发式，一定会漏。漏掉的那次至少要在会话日志里留得下一条 noted——
     *     没有它，「事后查得到」这句话只是文档上的一句话。
     */
    const push = all(r.scopePush)
    assert(!push.length, `作用域下推这几条不对：${push.join('、')}`)
    const note = all(r.noteWrites)
    assert(!note.length, `事后补记这几条不对：${note.join('、')}`)
  })

  await test('注入页面的那段脚本，语法得是对的', () => {
    /**
     * **它是拼字符串拼出来的，TypeScript 只看得见「这是个模板字符串」。** 里面一个
     * 反引号、一个少写的反斜杠，都会让发到页面上的代码语法错误——而表现不是某一把
     * 工具坏了，是**所有 browser_\* 一起失灵**，且只有真连上浏览器才看得见。
     *
     * 加这条的那天栽了两次：注释里写了反引号（模板字符串提前闭合）、正则里的反斜杠
     * 只写了一遍（发过去成了提前闭合的正则）。这条不需要浏览器，两次都当场抓得住。
     */
    const bad = all(r.pageScript)
    assert(!bad.length, `这几条不对：${bad.join('、')}${r.pageScriptError ? '（' + r.pageScriptError + '）' : ''}`)
  })

  await test('判地址和判主机名是两件事：公网 IPv6 不能被当成内网', () => {
    /**
     * **线上撞过一次，代价是所有 https 站点全打不开。**
     *
     * 响应回来那一步拿到的是已经解析好的 IP，早先直接喂给了 `blockedHost`——而那个函数
     * 是给 URL 里的**主机名**写的，带着「不带点的一律拒」这类只对主机名成立的启发式
     * （内网机器多半就叫 `gitlab`、`nas` 这样一个词）。一个公网 IPv6 里恰好没有点，于是
     * 被当成内网机器名拦下，页面被弹回空白页，而报出来的是一句和原因毫无关系的
     * 「只能打开 http / https 的地址」——照着它去查协议、查网址，怎么查都查不出来。
     *
     * 所以这条既钉「公网地址别拦」，也钉「主机名那套启发式别跟着松」。
     */
    const bad = all(r.addressVsHost)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('浏览器：像提交的才弹卡片，点一下看看的不弹', () => {
    /**
     * `browser_click` 正好是 `external + write`，照通用规则判就是每一次点击都弹一张
     * 卡片——那不是收紧边界，那是让人学会闭眼点批准（terminal 那条分支写过同一件事）。
     *
     * 反过来也要钉住：「先 type 再 press Enter」和 `submit: true` 是同一件事，
     * 放过其中一个，模型换个写法就绕过去了——而它换写法不需要任何恶意。
     */
    const bad = all(r.browserApproval)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('策略够得着目录：serverOf 这个接缝类型检查看不见，得靠断言守着', () => {
    // 策略是 `reflect.get('catalog') as { serverOf?… }` 取的服务——目录那边没有这个
    // 方法，tsc 一声不吭，而运行时每一次 mcp_* 调用都会被判成「不属于任何已授权的
    // MCP 服务器」：边界一条没关，Bot 却连一把连接器都用不了。
    assert(r.seam.目录给得出serverOf, 'CatalogService 上没有 serverOf，策略够不着 MCP 的归属')
    assert(r.seam.策略认得出未注册的服务器, '认不出归属时没有 fail closed')
  })

  await test('MCP 风险：perm 是权威，动词只往严了推', () => {
    assert(!r.mcpRisk.只读的查询.includes('write'), '只读的查询被判成写')
    // 连接器合成出来的服务器 perm 默认就是「只读」，而里面躺着 SEND_EMAIL——
    // 只信 perm 的话，「对外发送前先确认」这条边界对连接器整个失效。
    assert(r.mcpRisk.只读服务器上的发送.includes('write'), '只读服务器上的 SEND 没被判成写')
    assert(r.mcpRisk.删除.includes('destructive'), 'DELETE 没被判成破坏性')
  })
}
