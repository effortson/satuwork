/**
 * Bot 侧工具搜索（docs/tool-search-bot.md）。两个探针：
 *
 *   bot/e2e-tool-search-unit.mjs —— 纯函数：打分、中文查询、按 toolkit 合并、四档的边界、id 解析
 *   bot/e2e-tool-search-bot.mjs  —— 真的目录服务 + 325 把工具的 stub MCP，搜、看、调一条龙，
 *                                   要审批的那把经 tool_call 弹真名的卡
 *
 * 要守的线（§13）：工具表和清单逐字节不变；被延迟的一律搜得到、调得通；经 tool_call 调和直接调
 * 在策略、审批、事件上等价，名字也一样；连接器的描述不进系统提示词；关掉之后和今天一样。
 */
import { runProbe } from './probe.mjs'

export async function runToolSearchBot({ root, test, assert, log }) {
  log('\n# tool-search-bot')
  let u
  let b

  await test('纯函数探针跑得完', async () => {
    u = await runProbe(root, 'bot/e2e-tool-search-unit.mjs')
    assert(u && u.ids && u.incident && u.search && u.unwrap, `结果不完整：${JSON.stringify(u)}`)
  })

  await test('id：连接名人认得出、不撞、大小写和带前缀的写法都认', () => {
    assert(u.ids.total === 324 && u.ids.unique, `id 撞了：${JSON.stringify(u.ids)}`)
    assert(u.ids.connName === 'google_drive_personal', `连接名不对：${u.ids.connName}`)
    assert(u.ids.resolves && u.ids.caseInsensitive && u.ids.fullRemote, `id 解析不对：${JSON.stringify(u.ids)}`)
    assert(u.ids.unknown && u.ids.noColon, '认不出的 id 不该瞎配')
    const c = u.ids.clash
    assert(c.before === 'gmail_a_b:SEND_EMAIL' && c.oldAfter === c.before, `新加一把连接，老连接的 id 挪了：${JSON.stringify(c)}`)
    assert(/^gmail_a_b_[0-9a-f]{4}:SEND_EMAIL$/.test(c.newAfter) && c.unique, `撞名没补哈希：${JSON.stringify(c)}`)
    assert(
      JSON.stringify(u.ids.dup.ids) === JSON.stringify(['google_drive_x:FIND_FILE', 'google_drive_x:GOOGLEDRIVE_FIND_FILE']) &&
        u.ids.dup.clashes.length === 1 &&
        u.ids.dup.bothReachable,
      `同一把连接里撞 slug 被静默遮掉了：${JSON.stringify(u.ids.dup)}`,
    )
    assert(u.ids.prefixStripped === 'notion_work:CREATE_PAGE', `toolkit 前缀没去掉：${u.ids.prefixStripped}`)
  })

  await test('按 toolkit 合并：4 个 Drive 一组，关掉的那把标「仅 xxx」', () => {
    assert(u.incident.groups.length === 5, `该是 5 组：${JSON.stringify(u.incident.groups)}`)
    assert(u.incident.groups.includes('Google Drive:4:50'), `Drive 没合成一组：${JSON.stringify(u.incident.groups)}`)
    assert(u.incident.listingHasDrive, '组头没列出四个连接')
    assert(u.incident.onlyMarked, '某个连接上关掉的工具没标「仅 xxx」')
    assert(u.incident.stable, '同一份输入算两次清单不一样——缓存每轮都废')
  })

  await test('四档：30 把是第 0 档，31 把就切；off / on / 小窗口各归各档', () => {
    assert(u.boundary.at30 === 0 && u.boundary.tier0DirectAll === 30, `30 把该全量直出：${JSON.stringify(u.boundary)}`)
    assert(u.boundary.at31 >= 1, `31 把该切到搜索：${JSON.stringify(u.boundary)}`)
    assert(u.boundary.offAt300 === 0, 'off 该一律全量')
    assert(u.boundary.onAt3 >= 1, 'on 该跳过第 0 档')
    assert(u.boundary.onAllRecommended === 0, 'on 档一把都没延迟时还摆着三把搜不到东西的桥接工具')
    assert(u.boundary.directMax5 >= 1, 'DIRECT_MAX 没生效')
    assert(u.boundary.notAllowed === 0, '不在这颗 Bot 名单里的服务器被算进来了')
    assert(u.incident.tier >= 1 && u.incident.direct === 0 && u.incident.deferred === 324, `事故那份配置：${JSON.stringify(u.incident)}`)
    assert(u.incident.tinyTier === 3 && /^Gmail（2 个连接，25 个工具）/.test(u.incident.tinyListing), `窗口小时该退到每组一行：${u.incident.tinyListing}`)
    assert(u.incident.wideTier === 1 && u.incident.wideHasDesc, '预算宽时该是带描述的第 1 档')
    assert(JSON.stringify(u.env.defaults) === JSON.stringify({ mode: 'auto', directMax: 30, listingMax: 4000 }), `默认值不对：${JSON.stringify(u.env.defaults)}`)
    assert(u.env.parsed.mode === 'off' && u.env.parsed.directMax === 12 && u.env.parsed.listingMax === 4000, `环境变量没读对：${JSON.stringify(u.env.parsed)}`)
  })

  await test('推荐集直出，超了线按连接多的先退', () => {
    assert(u.recommended.direct.length === 4 && u.recommended.notInDeferred, `推荐集：${JSON.stringify(u.recommended)}`)
    assert(u.recommended.cappedDirect === 0, `超线没退：${u.recommended.cappedDirect}`)
  })

  await test('搜索：英文、中文、精确 id 都搜得到；最稀有的词必须命中', () => {
    const s = u.search
    assert(s.english[0] === 'SEND_EMAIL', `send email：${s.english}`)
    assert(s.findFile[0] === 'FIND_FILE', `find file：${s.findFile}`)
    assert(s.zhSend[0] === 'SEND_EMAIL', `「帮我发邮件」：${s.zhSend}`)
    assert(s.zhFind[0] === 'FIND_FILE', `「去 Drive 里找 7-11 方案」：${s.zhFind}`)
    assert(s.zhShare[0] === 'SHARE_FILE', `「把文件共享给同事」：${s.zhShare}`)
    assert(s.zhSheet[0] === 'Google Sheets', `「表格」：${s.zhSheet}`)
    assert(s.exactSlug[0] === 'SHARE_FILE' && s.exactId[0] === 'REPLY_TO_THREAD', '精确的 slug / id 没命中')
    assert(s.rare.length === 0 && s.nonsense.length === 0, `不相干的查询凑出了结果：${JSON.stringify([s.rare, s.nonsense])}`)
    assert(s.stopword[0] === 'LIST_FILES' && !s.stopword.includes('ARCHIVE_ITEM'), `虚词当成了最稀有的词：${JSON.stringify(s.stopword)}`)
    assert(s.mergedConns.length === 4, `四个 Drive 的 FIND_FILE 该合成一条：${JSON.stringify(s.mergedConns)}`)
    assert(s.rendered.startsWith('google_drive_diana:FIND_FILE(query*: string, folder_id?: string, page_size?: integer)'), `签名不对：${s.rendered}`)
    assert(s.rendered.includes('也在：google_drive_personal、google_drive_syrius、google_drive_team'), `没写「也在」：${s.rendered}`)
  })

  await test('签名：必填打星、数组和嵌套对象写得出来', () => {
    assert(u.signature === '(q*: string, folder_id?: string, page_size?: integer, tags?: string[], opts?: object, mode?: enum, maybe?: string)', u.signature)
  })

  await test('tool_call 的壳在确认卡那一层剥得开：卡上是真名，改的格子写回 arguments 里', () => {
    assert(u.unwrap.tool === 'mcp_g1_send_email' && u.unwrap.formTool === 'mcp_g1_send_email', `没剥成真名：${JSON.stringify(u.unwrap)}`)
    assert(u.unwrap.formKind === 'email' && u.unwrap.bodyKey === 'arguments.body', `发信卡不对：${JSON.stringify(u.unwrap)}`)
    assert(u.unwrap.stringArgs.body === 'x', '字符串化的参数没解开')
    assert(u.unwrap.unknown === 'nope:X', '认不出的 id 该原样显示')
  })

  await test('一条龙探针跑得完', async () => {
    b = await runProbe(root, 'bot/e2e-tool-search-bot.mjs', { timeout: 90_000 })
    assert(b && b.pull?.ok && b.table && b.cards, `结果不完整：${JSON.stringify(b)?.slice(0, 2000)}`)
  })

  await test('目录同步：声明了 client.toolSearch，写了一行档位日志，status 里看得到', () => {
    assert(b.pull.servers === 10, `九把连接加一台公司 MCP 没都连上：${JSON.stringify(b.pull)}`)
    assert(b.declared, 'tools/list 没带 client.toolSearch——Gateway 还会降成 SW_*')
    assert(b.companyNotDeclared, '公司自配的 MCP 也收到了 client.toolSearch——校验严的第三方服务器会整台拒掉')
    assert(/^工具搜索：第 [123] 档，延迟 325 把（9 个连接、5 组），直出 0 把，清单约 \d+ token$/.test(b.tierLog ?? ''), `档位日志：${b.tierLog}`)
    assert(b.status && b.status.tier >= 1 && b.status.deferred === 325 && b.status.groups.length === 5, `status：${JSON.stringify(b.status)}`)
  })

  await test('工具表里一把 mcp_* 都没有，只有内置加三把桥接；清单在 tool_search 的描述里，不在系统提示词里', () => {
    assert(b.table.mcpInTable === 0, `还有 ${b.table.mcpInTable} 把 mcp_* 在表里`)
    assert(b.table.bridges, '三把桥接工具不全')
    assert(b.table.listingHasDrive && b.table.listingHasGmail, '清单没按组写进 tool_search 的描述')
    assert(b.table.systemClean, '连接器的东西进了系统提示词')
    assert(b.sections.deferredTools === 325 && b.sections.directMcpTools === 0 && b.sections.toolSearchTier >= 1, `request/header 的 sections：${JSON.stringify(b.sections)}`)
  })

  await test('搜（中文）→ 看 → 在指定连接上调，参数按 schema 矫正', () => {
    assert(/^## 在 Drive 里找文件\ngoogle_drive_\w+:FIND_FILE\(query\*: string, page_size\?: integer\)/.test(b.search), `中文没搜到 FIND_FILE：${b.search.slice(0, 400)}`)
    assert(b.search.includes('gmail_personal:SEND_EMAIL('), `send email 没搜到：${b.search}`)
    assert(b.describe.includes('"page_size"') && b.describe.includes('也在：'), `describe：${b.describe.slice(0, 300)}`)
    assert(b.findCall && b.findCall.conn === 'd2', `没调到指定的那把连接：${JSON.stringify(b.findCall)}`)
    assert(b.findCall.args.page_size === 5, `"5" 没矫正成 5：${JSON.stringify(b.findCall.args)}`)
    assert(b.findResult === 'STUB-OK d2 FIND_FILE', b.findResult)
  })

  await test('参数不对在本地拦下，不打上游；id 写错了说清楚', () => {
    assert(b.badArgs.upstreamHits === 0, '校验没过的调用打到了上游')
    assert(b.badArgs.text.includes('没通过校验') && b.badArgs.text.includes('recipient_email'), b.badArgs.text)
    assert(b.typo.includes('google_drive_personl') && b.typo.includes('google_drive_personal'), `写错 id 的提示：${b.typo}`)
  })

  await test('要审批的工具经 tool_call 调：弹真名的卡，批了才发，会话日志也记真名', () => {
    assert(b.cards.length === 1, `该弹一张卡：${JSON.stringify(b.cards)}`)
    const card = b.cards[0]
    assert(card.name === 'mcp_gmail_work_send_email' && card.formTool === 'mcp_gmail_work_send_email', `卡上不是真名：${JSON.stringify(card)}`)
    assert(card.formKind === 'email' && card.reason.startsWith('mcp_gmail_work_send_email'), `卡片不对：${JSON.stringify(card)}`)
    assert(b.send.upstream?.conn === 'g1' && b.send.result === 'STUB-OK g1 SEND_EMAIL', `批了没发：${JSON.stringify(b.send)}`)
    const viaCall = b.toolCallEvents.filter((c) => c.via === 'tool_call').map((c) => c.name)
    assert(viaCall.includes('mcp_gmail_work_send_email') && viaCall.some((n) => n.includes('personal_find_file')), `tool/call 没记真名：${JSON.stringify(b.toolCallEvents)}`)
    assert(b.secondTurn.every((r) => r === 'completed'), `带 via 的历史重建出了问题：${b.secondTurn}`)
  })

  await test('tool_search 每次记一条，零命中的捞得出来', () => {
    assert(b.searchLogged, '搜索没记日志')
    assert(b.zeroHitLogged, '零命中的查询没记日志——意图表靠它补')
  })

  await test('委派：tools 里写 id，子任务拿到桥接工具、只够得着那一把；拒掉的调用记壳名', () => {
    const d = b.delegate
    assert(d && d.state === 'done', `委派没跑完：${JSON.stringify(d)}`)
    assert(d.childHasBridges, '子任务的表里没有桥接工具，够不着被延迟的那把')
    assert(d.fetched === 1, `给了的那把没调成：${JSON.stringify(d)}`)
    assert(d.findBlocked, '没给子任务的那把被它调到了上游')
    assert(d.refusedLoggedAsShell, '拒掉的那次被记成了真名——审计里像是调了一把没授权的工具')
    assert(d.fetchLoggedReal, '真跑了的那次没记真名')
  })

  await test('@ 点名：工具表一个字节不动，签名补在这条用户消息里，重建历史原样拼回', () => {
    const m = b.mention
    assert(m.tableUnchanged, '点名改了工具表——缓存从头废')
    assert(m.block && m.slidesListed, '点名那一段没写、或者没带签名')
    assert(m.restHint, '工具多于 20 把时该只列推荐集，其余让它搜')
    assert(m.stored && m.replayed, '那一段没跟着消息落盘 / 下一轮没拼回去')
  })

  await test('SATUWORK_TOOL_SEARCH=off：不声明、全量进表、没有桥接工具（等于今天）', () => {
    assert(!b.offDeclared, 'off 了还在声明 client.toolSearch')
    assert(b.off.mcpInTable === 325 && b.off.bridges === 0, `off 之后：${JSON.stringify(b.off)}`)
  })
}
