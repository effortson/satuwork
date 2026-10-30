/** 头像动画跟着真实运行状态启停，不重建 SVG，也不把历史回复画成运行中。 */
import { join } from 'node:path'
import { loadApp } from './ui-dom.mjs'

function avatarNode() {
  const attrs = new Map()
  return {
    writes: 0,
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute(name, value) { attrs.set(name, value); this.writes++ },
    removeAttribute(name) { attrs.delete(name); this.writes++ },
  }
}

export async function runAvatarMotion({ root, test, assert, log }) {
  const open = () => {
    const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base: 'http://127.0.0.1:9', token: 'jwt', stubIds: ['chat-avatar'] })
    ui.state.me = { account: { id: 'u1', companyId: 'c1', role: 'member' }, company: { id: 'c1' } }
    ui.state.path = '/a/b1'
    ui.state.chatBotId = 'b1'
    ui.state.runtimeBots = [{ id: 'b1', name: '助理', icon: 'c-bot', origin: 'company', runtime: { status: 'ready', machineLink: 'online' } }]
    return ui
  }
  log('\n# avatar-motion')

  await test('名单初次渲染认实时运行状态，停止后回到静态，皇冠保留', async () => {
    const ui = open()
    ui.state.mainBotId = 'b1'
    assert(!ui.chatRosterNav().includes('data-running="true"'), '空闲头像不该动')
    ui.noteRosterFrame({ type: 'roster/live', botId: 'b1', live: true })
    const html = ui.chatRosterNav()
    assert(html.includes('data-running="true"') && html.includes('satu-crown'), '执行时要动且保留皇冠')
    ui.noteRosterFrame({ type: 'roster/live', botId: 'b1', live: false })
    assert(!ui.chatRosterNav().includes('data-running="true"'), '权威停止帧后还在动')
  })

  await test('名单增量更新原地启停：连续流式帧不重置动画，不替换头像', async () => {
    const ui = open()
    const art = avatarNode()
    const host = { querySelector: () => art }
    const row = { getAttribute: () => 'b1', querySelector: (sel) => sel === '.satu-botavatar' ? host : null }
    ui.document.querySelectorAll = (sel) => sel === '[data-bot-row]' ? [row] : []
    ui.noteRosterFrame({ type: 'roster/live', botId: 'b1', live: true })
    ui.paintRoster()
    const writes = art.writes
    for (let i = 0; i < 20; i++) ui.paintRoster()
    assert(art.getAttribute('data-running') === 'true' && art.writes === writes, '连续刷新重置了动画')
    ui.noteRosterFrame({ type: 'roster/live', botId: 'b1', live: false })
    ui.paintRoster()
    assert(art.getAttribute('data-running') === null && art.writes === writes + 1, '没原地停下')
  })

  await test('待人工、失联、安装中和本机未就绪时，忙碌帧也不触发运行动画', async () => {
    const ui = open()
    const bot = ui.state.runtimeBots[0]
    ui.noteRosterFrame({ type: 'roster/live', botId: 'b1', live: true })
    const sum = ui.botStreamOf('b1').sum
    sum.asks = new Map([['approval', {}]])
    ui.settleDot(sum)
    assert(!ui.botIsWorking(bot, true), '等拍板时不该继续工作动画')
    sum.asks.clear()
    ui.settleDot(sum)
    for (const link of ['offline', 'stale', 'unpaired']) {
      bot.runtime.machineLink = link
      assert(!ui.botIsWorking(bot, true), `${link} 时不该继续动`)
    }
    bot.runtime.machineLink = 'online'
    bot.runtime.status = 'deploying'
    assert(!ui.botIsWorking(bot, true), '安装中不该动')
    bot.runtimeKind = 'local'
    bot.runtime.status = 'starting'
    assert(!ui.botIsWorking(bot, true), '本机未就绪不该动')
    bot.runtime.status = 'ready'
    assert(ui.botIsWorking(bot), '本机就绪且在执行时应恢复动画')
  })

  await test('对话顶栏跟随当前轮次启停，失联时不保留忙碌假象', async () => {
    const ui = open()
    const art = avatarNode()
    ui.stubs.get('chat-avatar').querySelector = () => art
    ui.paintChatChrome({ status: 'working', blocks: [] })
    assert(art.getAttribute('data-running') === 'true', '对话开始时头像没动')
    ui.paintChatChrome({ status: '', blocks: [] })
    assert(art.getAttribute('data-running') === null, '对话结束后头像还在动')
    ui.state.runtimeBots[0].runtime.machineLink = 'offline'
    ui.paintChatChrome({ status: 'working', blocks: [] })
    assert(art.getAttribute('data-running') === null, '失联后不该沿用过期的轮次状态')
  })

  await test('头像默认静止，旧键和十个岗位都保留，选择器与历史头像不自动播放', async () => {
    const ui = open()
    for (const key of ['c-bot', 'c-chat', 'c-chart', 'c-pen', 'c-deal', 'c-code', 'c-flow', 'c-book', 'c-design', 'c-finance']) {
      assert(!ui.botAvatar(key).includes('data-running'), `${key} 默认不该动`)
      assert(ui.botAvatar(key, 24, 'company', true).includes(`data-avatar="${key}" data-running="true"`), `${key} 无法启用动画`)
    }
    assert(ui.botAvatar('code') === ui.botAvatar('c-code'), '旧头像键不兼容')
    assert(!ui.botAvatar('g-core').includes('satu-bot-art'), '全局头像被误换成公司头像')
  })
}
