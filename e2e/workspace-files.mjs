/**
 * 工作区的边界语义。探针在 bot/e2e-workspace.mjs（要 tsx 才 import 得了 .ts）。
 *
 * 这一层钉的几乎全是**安全边界**。它们和别的回归不一样：写松了不会有人报 bug，
 * 功能照跑，要等到有人专门去试才发作。所以每一条都单独钉死，包括那些看起来
 * 「显然不会错」的。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-workspace.mjs')

export async function runWorkspaceFiles({ root, test, assert, log }) {
  log('\n# workspace-files')
  let r
  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.escape && r.upload, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('列目录：目录在前、隐藏项和符号链接不列、越界照样拦', () => {
    assert(r.list.路径 === 'sub', `path → ${r.list.路径}`)
    assert(r.list.目录在前, `顺序不对：${JSON.stringify(r.list.条目)}`)
    assert(r.list.带大小 === 2, `a.txt 的大小 → ${r.list.带大小}`)
    // 这个 path 要能直接喂给预览接口——两处对不上的话，树上点开就是 404。
    assert(r.list.路径可直接预览 === 'sub/a.txt', `path → ${r.list.路径可直接预览}`)
    assert(r.list.没有符号链接, '符号链接被列出来了，那是一条能走出工作区的路')
    assert(r.list.没有隐藏项, '隐藏项被列出来了')
    assert(r.listEscape, '`../../../etc` 没被拦住')
    assert(r.listFile, '拿文件当目录列没被拦住')
  })

  await test('只读工具报出看到的文件，写只报产出', () => {
    // 没有这一条，界面就只能回去正则扫工具结果的文本猜路径——那正是这套设计要躲开的。
    assert(r.refs.列文件.includes('sub/note.md'), `列文件 → ${JSON.stringify(r.refs.列文件)}`)
    assert(r.refs.读.length === 1 && r.refs.读[0] === 'sub/note.md', `read_file → ${JSON.stringify(r.refs.读)}`)
    assert(r.refs.搜内容.includes('sub/note.md'), `搜内容 → ${JSON.stringify(r.refs.搜内容)}`)
    assert(r.refs.找文件.includes('sub/note.md'), `找文件 → ${JSON.stringify(r.refs.找文件)}`)
    // 目录不进 refs：那一屏点开的是预览，目录预览不了。
    assert(!r.refs.列文件.some((p) => p.endsWith('/deep')), `目录也被报进 refs：${JSON.stringify(r.refs.列文件)}`)
    assert(r.refs.写的是产出.includes('sub/new.txt'), `write_file → ${JSON.stringify(r.refs.写的是产出)}`)
    assert(r.refs.写的不报refs, 'write_file 把产出又报了一遍 refs，界面会摆两次')
  })

  await test('隐藏项默认不列，点名才出来', () => {
    // `ls` 一直是这个口径。工作区是员工的办公目录，.DS_Store 这类东西摆进结果里
    // 只会把真正的文件挤下去。
    assert(!r.refs.列文件.some((p) => p.includes('/.')), `隐藏项被列出来了：${JSON.stringify(r.refs.列文件)}`)
    assert(r.refs.隐藏项要点名.includes('sub/.hidden'), `点名了也没列出来：${JSON.stringify(r.refs.隐藏项要点名)}`)
  })

  await test('搜索翻页：refs 只报真的摆出来了的那些文件', () => {
    // 被 offset 整个翻过去的文件一行都没进正文，进了 refs 就是在正文底下摆一颗指向
    // 「正文根本没提过的文件」的药丸——而 refs 存在的全部意义就是把正文里的文件名接上。
    const bad = Object.entries(r.paging2).filter(([, v]) => v !== true).map(([k]) => k)
    assert(!bad.length, `这几条不对：${bad.join('、')}（${JSON.stringify(r.paging2)}）`)
  })

  await test('read_file 分页：接着读的那个 offset 不许算错一位', () => {
    // 大文件必然要分页，而分页的唯一出口是末尾那句话里的 offset。算错一位，模型要么
    // 漏一行要么重复一行——两种都看不出来，它只会照着读下去。
    assert(r.paging.首页最后一行 === '5|第 5 行', `limit 没生效：${r.paging.首页最后一行}`)
    assert(r.paging.接着读的提示 === '…（还有 55 行，用 offset=6 接着读）', `提示不对：${r.paging.接着读的提示}`)
    assert(r.paging.第二页第一行 === '6|第 6 行', `接着读接错了：${r.paging.第二页第一行}`)
    assert(/超出文件长度/.test(r.paging.越界), `offset 越界没说清楚：${r.paging.越界}`)
    // 压成一行的 JSON / 日志：那一行按字符截断，但行还在，后面的行照读。
    assert(r.paging.超长单行不空, '超长单行读回来是空的')
    assert(r.paging.超长单行被截断, '超长单行没截断，整份内容会冲掉上下文')
    assert(r.paging.截断之后后面的行还在, '截断之后就不往下读了')
  })

  await test('遍历预算：走满不等于走不完', () => {
    /**
     * `walkFiles` 是「要 yield 之前先减」，所以正好走满预算的那一趟以 `left === 0`
     * 干干净净地结束。按 `left <= 0` 判「没走完」会把一份完整的结果丢掉——差一个文件，
     * 而且是静默的：terminal 的产出扫描就是靠这个判据决定报不报，判错了这个功能在那种
     * 大小的工作区上永远不出声，而屏幕上跟「这条命令确实没产出」一模一样。
     */
    const bad = Object.entries(r.walkBudget).filter(([, v]) => v !== true).map(([k]) => k)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('file 工具集：行号格式、目录可见、旧名字有出路', () => {
    // 行号格式是 patch 剥前缀的前提——它一变，模型从 read_file 里复制粘贴的 old_string
    // 就再也剥不干净，而报出来的会是「没找到那段文本」。
    assert(r.file.行号格式 === '1|# hi', `行号格式变了：${JSON.stringify(r.file.行号格式)}`)
    assert(r.file.父目录自动建, 'write_file 没有自动创建父目录')
    // `ls` 的那半个用途：这层底下有哪些目录。少了它，模型看不见空目录。
    assert(r.file.目录看得见, 'search_files(target=files) 没有报出这一层的子目录')
    assert(r.file.目录不是文件, '目录被当成结果条目列出来了，喂回 read_file 会失败')
    assert(r.file.只列匹配的, 'glob 没起作用')
    assert(r.file.按名字数 === 'sub/note.md: 1', `output_mode=count → ${r.file.按名字数}`)
    assert(r.file.带上下文, 'context 没带出上下文行')
    assert(r.file.目录不能读, 'read_file 读目录时没有指向 search_files')
    // 历史里全是旧名字，模型会照着再调。失败文本里必须带着出路，否则它会原样重试到步数上限。
    assert(/已经改名为 search_files/.test(r.file.旧名字有出路), `旧名字没给出路：${r.file.旧名字有出路}`)
    assert(!/改名/.test(r.file.没注册的还是没注册), `不认识的工具被当成改名了：${r.file.没注册的还是没注册}`)
  })

  await test('路径逃不出工作区', () => {
    assert(r.escape.上跳, '`../../../etc/passwd` 没被拦住')
    assert(r.escape.绕一圈上跳, '先下去再上来能绕过检查')
    assert(r.escape.绝对路径, '绝对路径没被拦住')
    // `/work` 与 `/workx`：只比字符串前缀会把兄弟目录当成子目录放行。
    assert(r.escape.同前缀兄弟目录, '同前缀的兄弟目录被当成了工作区内部')
    assert(r.escape.根自己可以 && r.escape.正常路径可以, '正常路径被误伤')
  })

  await test('上传的文件名变不成路径', () => {
    assert(r.names.上跳变普通名 === 'evil.sh', `../../evil.sh → ${r.names.上跳变普通名}`)
    // Windows 的分隔符也算分隔符——浏览器传上来的名字是外部输入，不挑平台。
    assert(r.names.反斜杠也算分隔符 === 'evil.sh', `..\\..\\evil.sh → ${r.names.反斜杠也算分隔符}`)
    assert(r.names.纯点号不留 === 'file', `... → ${r.names.纯点号不留}`)
    assert(r.names.空名有兜底 === 'file', '空文件名没有兜底')
    // 换行能把 Content-Disposition 那一行撑破。
    assert(r.names.控制字符剔掉 === 'abc.txt', `控制字符没剔干净：${r.names.控制字符剔掉}`)
    assert(r.names.中文原样留着 === '二季度报表.xlsx', '中文名被洗坏了')
    assert(r.names.超长截断 === 200, `超长名没截断：${r.names.超长截断}`)
  })

  await test('删：文件、目录连里面一起，根和符号链接一律不给', () => {
    const d = r.remove
    assert(d.删得掉文件, '文件没删掉')
    assert(d.报出删了什么 === 'del/a.txt', `报出来的路径不对：${d.报出删了什么}`)
    assert(d.目录连里面一起删 && d.说清楚删的是目录, `目录没删干净：${JSON.stringify(d)}`)
    // 下面这三条是这一组存在的理由：写松了功能照跑，要等到有人专门去试才发作。
    assert(d.越界拦得住, '`../../../etc/passwd` 能删')
    assert(d.根删不掉 && d.点号也是根, '空 path / `.` 能把整个工作区删掉')
    assert(d.符号链接不给删 && d.符号链接指的目录还在, '顺着符号链接删到了工作区外面')
    // 只认最后一段是不够的：resolve() 不 realpath，`out/keep.txt` 拼出来照样落在根
    // 以内，而末段是个规规矩矩的文件——删掉的是工作区外面那一份。
    assert(d.穿过链接的不给删 && d.外面那份还在, '穿过符号链接把工作区外面的文件删掉了')
    assert(d.穿过链接删目录也不给 && d.外面那个目录还在, '穿过符号链接把工作区外面的目录删掉了')
    assert(d.不存在的报ENOENT === 'ENOENT', `删一个不存在的东西没报出来：${d.不存在的报ENOENT}`)
    assert(d.工作区还在, '删完一层把工作区根一起带走了')
  })

  await test('本地模式：悬空符号链接一样不放行', () => {
    // existsSync 跟着链接走，悬空链接会被当成「不存在」——逐段检查要是据此提前收手，
    // write_file 就顺着它在工作区外面新建文件（比如一条指向 LaunchAgents 的 plist）。
    const bad = Object.entries(r.dangling || {}).filter(([, v]) => v !== true).map(([k]) => k)
    assert(r.dangling && !bad.length, `这几条不对：${bad.join('、')}（${JSON.stringify(r.dangling)}）`)
  })

  await test('只有白名单里的类型允许内联', () => {
    assert(r.inline.png && r.inline.pdf, '图片和 PDF 应该能直接看')
    assert(r.inline.大写后缀也认, '大写后缀没认出来，会被当成未知格式')
    // 这两个能带 <script>。内联它们，等于让上传者在 Gateway 的源上执行代码。
    assert(!r.inline.svg, 'SVG 被允许内联了——这是 XSS')
    assert(!r.inline.html, 'HTML 被允许内联了——这是 XSS')
    assert(!r.inline.未知格式, '未知格式默认应该是下载')
    assert(r.inline.未知格式的类型 === 'application/octet-stream', '未知格式的 MIME 不对')
    assert(r.inline.markdown按纯文本发.startsWith('text/plain'), 'markdown 该按纯文本发，浏览器才不会去下载它')
  })

  await test('上传落进 uploads，字节一个不差', () => {
    assert(r.upload.路径在uploads下 === 'uploads/sess-1/hello.txt', `落点不对：${r.upload.路径在uploads下}`)
    assert(r.upload.内容 === 'hello world', `内容对不上：${r.upload.内容}`)
    assert(r.upload.大小 === 11, `大小对不上：${r.upload.大小}`)
  })

  await test('同名不覆盖', () => {
    // 传两次同名文件是常事，覆盖掉就是数据丢失，而且是静悄悄的那种。
    assert(r.collision.换了名字, '第二份把第一份盖掉了')
    assert(r.collision.头一份还在 === 'hello world', `头一份被改了：${r.collision.头一份还在}`)
    assert(r.collision.新路径 === 'uploads/sess-1/hello-1.txt', `换的名字不对：${r.collision.新路径}`)
  })

  await test('恶意文件名和恶意 sessionId 都出不去', () => {
    assert(r.evilName.没跑出uploads, `文件名把落点带出去了：${r.evilName.落点}`)
    assert(r.evilName.外面没被写, '真的写到 /etc/cron.d 去了')
    assert(r.evilSession.没跑出uploads, `sessionId 把落点带出去了：${r.evilSession.落点}`)
    // 清洗完不该在磁盘上留下一串点当目录名——跑不出去，但会让人以为出了别的事。
    assert(!/\/\.+\//.test('/' + r.evilSession.落点), `落点里留下了点目录：${r.evilSession.落点}`)
  })

  await test('超过上限就地中断，不留半个文件', () => {
    // 先收完再看大小，等于让任何人都能拿磁盘换一次拒绝。
    assert(r.tooBig.报错, '超限没报错')
    assert(r.tooBig.没留残骸, '超限之后留下了半个文件')
  })

  await test('预览读得回原始字节，且一样逃不出去', () => {
    assert(r.open.类型 === 'image/png', `类型不对：${r.open.类型}`)
    assert(r.open.字节读得回来 === '89504e47', `字节对不上：${r.open.字节读得回来}`)
    assert(r.openEscape, '预览能读工作区外面的文件')
  })
}
