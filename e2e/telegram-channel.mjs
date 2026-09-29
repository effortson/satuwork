import { runProbe } from './probe.mjs'

export async function runTelegramChannel({ root, test, assert, log }) {
  log('\n# telegram-channel')
  const result = await runProbe(root, 'bot/e2e-telegram-channel.mjs')

  await test('Telegram 识别 /new、/tasks 与 /mentions 命令', async () => {
    assert(result.commands.join(',') === 'new,new,tasks,mentions', `命令解析错误：${result.commands}`)
  })

  await test('Telegram 的 @ 名字转成 Web 同款结构化点名', async () => {
    assert(result.parsed.text === '查邮件并建立页面', `正文没有去掉 @ 前缀：${result.parsed.text}`)
    assert(result.parsed.mentions.map((m) => m.id).join(',') === 'gmail-personal,notion', `点名解析错误：${JSON.stringify(result.parsed)}`)
    assert(result.ambiguous.unknown === 'Gmail', '两把同名 Gmail 的简写应该被判为歧义')
    assert(result.help.includes('@Gmail_personal') && result.help.includes('@Gmail_work'), '帮助没有给出无歧义的 @ 名字')
  })

  await test('Telegram 任务清单使用 RichMessage 可渲染的 Markdown 任务项', async () => {
    assert(result.todos.includes('## 任务 · 1/3 已完成'), '任务进度标题不对')
    assert(result.todos.includes('- [x] 读取邮件'), '已完成任务没有勾选')
    assert(result.todos.includes('- [ ] ▶ 建立 \\*\\*页面\\*\\*'), '进行中任务或 Markdown 转义不对')
    assert(result.todos.includes('- [ ] ✗ ~~旧步骤~~'), '取消任务没有显示取消状态')
  })

  await test('Telegram 下一轮开始时清空已结束任务，但保留未完成任务', async () => {
    assert(result.settledCleared && result.settledValue == null, '全部结束的旧任务没有清空')
    assert(result.settledSnapshots.length === 1 && result.settledSnapshots[0].type === 'todo/list'
      && result.settledSnapshots[0].data.items.length === 0, '清空后没有广播空任务快照')
    assert(result.openCleared === false && result.openValue?.some((item) => item.status === 'pending'), '未完成任务被提前清空')
    assert(result.openSnapshots.length === 0, '未完成任务不该广播空快照')
  })

  await test('Telegram 草稿按步骤合并完整消息与当前 text delta', async () => {
    assert(result.draft === '我先查行情。\n\n正在生成报告', `草稿合并错误：${JSON.stringify(result.draft)}`)
    assert(result.draft.match(/我先查行情/g)?.length === 1, '完整消息和流式分片重复了')
  })

  await test('Telegram 临时草稿按发生顺序接上工具调用，但不泄漏参数和结果', async () => {
    // 工具在它发生的位置占一行，不再维护末尾那张会被回头改的状态表（见下一条）。
    assert(result.toolDraft === '我先查一下。\n\n🔧 web_search\n🔧 web_extract\n🔧 browser_navigate',
      `工具行不对：${JSON.stringify(result.toolDraft)}`)
    assert(!result.toolDraft.includes('ETH') && !result.toolDraft.includes('example.test') && !result.toolDraft.includes('不能露出来'),
      `工具参数或结果泄漏到草稿：${result.toolDraft}`)
  })

  await test('Telegram 草稿只往后长：每一帧都以上一帧开头，客户端不会从头重播', async () => {
    const f = result.growFrames
    assert(result.growBroken === -1,
      `第 ${result.growBroken} 帧不以上一帧开头：\n上一帧 ${JSON.stringify(f[result.growBroken - 1])}\n这一帧 ${JSON.stringify(f[result.growBroken])}`)
    assert(f.at(-1) === '我先查一下。\n\n🔧 web_search\n🔧 web_extract\n\n找到了三条，整理中\n\n🔧 write_file\n\n报告写好了。',
      `最后一帧不对：${JSON.stringify(f.at(-1))}`)
    assert(!f.at(-1).includes('秘密'), '工具参数漏进了草稿')
  })

  await test('Telegram 只带回当前轮工具明确产出的文件并按路径去重', async () => {
    assert(result.files.map((f) => f.path).join(',') === 'reports/eth.html,reports/summary.pdf',
      `产出文件归集错误：${JSON.stringify(result.files)}`)
  })

  await test('Telegram 只带回当前轮新开的转人工卡', async () => {
    assert(result.handoffs.length === 1, `转人工卡数量不对：${JSON.stringify(result.handoffs)}`)
    assert(result.handoffs[0].id === 'handoff-current', '把别轮的旧转人工卡重复发出去了')
    assert(result.handoffs[0].ask === '提供验证码' && result.handoffs[0].summary === '已经登录到验证页',
      '转人工卡缺少任务或当前进展')
  })
}
