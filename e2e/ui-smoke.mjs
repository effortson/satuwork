/**
 * UI 冒烟：真 Gateway + 真 app.js + DOM 垫片。
 *
 * **不是真浏览器**（见 ui-dom.mjs 开头）。验的是「拿到真响应之后渲染出什么」，
 * 这一层专抓两类以前漏网的错：
 *
 * 1. boot 走错分支——手上有张上一套数据留下的废票时，画的是登录页而不是初始化页，
 *    而系统里一个账号都没有，那个登录页永远登不进去。
 * 2. 视图把正文渲染丢了——审计里每条消息都显示「（空）」，接口其实是好的。
 *
 * 两个都不是接口错，e2e 的状态码断言一个也拦不住。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { createCompany } from './org.mjs'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { el, fakeSse } from './ui-dom.mjs'
import { catchUpFrames, newCatchUp, remember } from '../manager/src/roster-filter.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { freePort } from './ports.mjs'

const APP = 'gateway/ui/app.js'

export async function runUiSmoke({ root, gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-ui-gw')
  const GW_PORT = await freePort()
  const gwBase = `http://127.0.0.1:${GW_PORT}`
  const appPath = join(root, APP)

  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# ui-smoke')

  const gw = start('ui-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: schemaOf('e2e_ui'),
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
    },
  })
  await waitHttp(`${gwBase}/health`, { child: gw, what: 'ui gateway' })

  const { loadApp } = await import('./ui-dom.mjs')
  const boot = async (token, opts) => {
    const ui = loadApp({ appPath, base: gwBase, token, ...opts })
    await ui.boot()
    return ui
  }

  try {
    await test('页面路径和 API 同名时，刷新拿 HTML、api() 仍拿 JSON', async () => {
      // `/channels` 同时是 SPA 地址和渠道 API。浏览器刷新会带 text/html，必须先交回
      // index.html；站内 api() 明确带 application/json，仍然走鉴权后的 JSON 路由。
      const page = await req(gwBase, 'GET', '/channels', { headers: { accept: 'text/html' } })
      assert(page.status === 200, `刷新 /channels → ${page.status} ${page.text}`)
      assert((page.headers.get('content-type') || '').includes('text/html'), `刷新 /channels 没拿到 HTML：${page.headers.get('content-type')}`)
      assert(page.text.includes('data-app-part'), '刷新 /channels 拿到的不是管理页 index.html')

      const api = await req(gwBase, 'GET', '/channels', { headers: { accept: 'application/json' } })
      assert(api.status === 401 && api.json?.error === '需要登录', `JSON /channels 没走原来的鉴权 API：${api.status} ${api.text}`)
    })

    await test('任务看板及自动整理接口已经下线', async () => {
      const page = await req(gwBase, 'GET', '/tasks', { headers: { accept: 'text/html' } })
      assert(page.status === 404, `已删除的 /tasks 页面仍返回 ${page.status}`)
      const api = await req(gwBase, 'GET', '/tasks', { headers: { accept: 'application/json' } })
      assert(api.status === 404, `已删除的 /tasks API 仍返回 ${api.status}`)
      const extract = await req(gwBase, 'POST', '/internal/tasks/extract', { body: { tasks: [] } })
      assert(extract.status === 404, `已删除的任务整理接口仍返回 ${extract.status}`)
    })

    await test('index.html 列出的每个前端分片都真的取得到', async () => {
      // 前端拆成了一串普通脚本，多一个分片就要在 http.ts 的 ROOT_FILES 里也加一行。
      // 漏了的表现很坏：本地开 index.html 一切正常，线上那一个 404，整个界面白屏。
      const html = readFileSync(join(root, 'gateway/ui/index.html'), 'utf8')
      const parts = [...html.matchAll(/<script src="\/([^"]+)"[^>]*\bdata-app-part\b/g)].map((m) => m[1])
      assert(parts.length > 1, `index.html 里没找到 data-app-part 脚本`)
      for (const f of parts) {
        const r = await req(gwBase, 'GET', '/' + f)
        assert(r.status === 200, `GET /${f} → ${r.status}，八成是 ROOT_FILES 白名单漏了它`)
      }
      // 最后一个分片必须是带 boot() 的那个，否则整串脚本加载完谁也不启动。
      const last = readFileSync(join(root, 'gateway/ui', parts[parts.length - 1]), 'utf8')
      assert(/\nboot\(\)\s*$/.test(last), `最后一个分片 ${parts[parts.length - 1]} 末尾没有 boot()`)
    })

    await test('Desktop 本地命令只放给包里那份界面（本地源），不放给任何远端页面', async () => {
      // 界面打在包里、由壳子自注册的 satu:// 协议发出来（Windows 上是 http://satu.localhost），
      // Tauri 把自注册的协议判为本地源，capability 不需要 remote 就够得着。这里以前带着
      // `remote.urls: http://*:* / https://*:*`——那是窗口直接装 Gateway 页面时代留下的，如今等于
      // 把 start_local_bot 放给主窗口里导航到的任何一个 http(s) 页面（导航守卫对
      // `/seats/<x>/vnc/` 这种路径是不看源的）。
      const dir = join(root, 'desktop/src-tauri/capabilities')
      const main = JSON.parse(readFileSync(join(dir, 'main.json'), 'utf8'))
      assert(main.windows?.includes('main'), `主窗口没有挂上这份 capability：${JSON.stringify(main.windows)}`)
      assert(main.permissions?.includes('local-bot-commands'), '主窗口调不了本地 Bot 那组命令了')
      assert(main.local !== false, '包里那份界面是本地源，local 不能关')
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
        const cap = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        assert(!cap.remote, `${f} 给远端页面开了 IPC：${JSON.stringify(cap.remote)}`)
      }
    })

    await test('桌面端关窗后恢复登录，浏览器仍只保留当前标签页', async () => {
      const key = 'satuwork.gateway.token'

      // 网页版的边界不变：票仍只写 sessionStorage。
      const browser = loadApp({ appPath, base: gwBase })
      browser.setToken('browser-token')
      assert(browser.sessionStorage.getItem(key) === 'browser-token', '网页版没有把票写进 sessionStorage')
      assert(browser.localStorage.getItem(key) == null, '网页版不该变成长期登录')

      // 桌面端登录后，关掉窗口会丢掉 sessionStorage；用同一份持久存储重开仍应拿回票。
      const first = loadApp({ appPath, base: gwBase, desktop: true })
      first.setToken('desktop-token')
      assert(first.sessionStorage.getItem(key) == null, '桌面票不该只留在会随关窗消失的 sessionStorage')
      assert(first.localStorage.getItem(key) === 'desktop-token', '桌面票没有写进持久存储')
      const reopened = loadApp({
        appPath,
        base: gwBase,
        desktop: true,
        persistentStorage: first.localStorage,
      })
      assert(reopened.token() === 'desktop-token', '桌面窗口重开后没有恢复登录票')
      reopened.clearToken()
      assert(reopened.localStorage.getItem(key) == null, '显式退出后持久票没有清掉')

      // 已经开着的旧版桌面页会有一张 sessionStorage 票；升级后第一次读取应无感迁移。
      const legacy = loadApp({ appPath, base: gwBase, desktop: true, token: 'legacy-token' })
      assert(legacy.token() === 'legacy-token', '旧桌面会话的登录票没有被读取')
      assert(legacy.localStorage.getItem(key) === 'legacy-token', '旧桌面会话的登录票没有迁到持久存储')
      assert(legacy.sessionStorage.getItem(key) == null, '迁移后 sessionStorage 里还留着重复票')
    })

    await test('空壳工具调用不画成药丸，它的结果也不许赖到别人头上', async () => {
      // bot 那边的下标错位已经修了（见 e2e/toolcalls.mjs），但**已经写下的日志里还留着**：
      // 翻上去看昨天那轮，每轮开头挂一颗红色的「tool · 失败」，点开里面什么都没有。
      const ui = await boot()
      const ev = (seq, type, data) => ({ seq, time: 1, type, data })
      const folded = ui.fold([
        ev(1, 'user/message', { message: { content: [{ type: 'text', text: '查一下' }] }, source: { kind: 'user' } }),
        ev(2, 'turn/start', { turn: 1 }),
        ev(3, 'tool/call', { turn: 1, step: 1, callId: '', name: '', arguments: '{}' }),
        ev(4, 'tool/call', { turn: 1, step: 1, callId: 'call_a', name: 'web_search', arguments: '{"q":"x"}' }),
        ev(5, 'tool/result', { turn: 1, step: 1, callId: '', text: 'Tool  not found', failed: true }),
        ev(6, 'tool/result', { turn: 1, step: 1, callId: 'call_a', text: '搜到了', failed: false }),
        ev(7, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '好了' }] } }),
        ev(8, 'turn/end', { turn: 1, reason: 'completed' }),
      ])
      const tools = folded.blocks.find((b) => b.kind === 'assistant')?.tools || []
      assert(tools.length === 1, `该只剩真的那一把：${JSON.stringify(tools.map((t) => t.name))}`)
      assert(tools[0].name === 'web_search', `留错了：${tools[0].name}`)
      // 空壳的结果要一起跳过。不跳的话它会按「第一条还没有结果的」认过去，
      // 把一次成功的调用标成失败——比多一颗药丸更坏，因为它是错的。
      assert(tools[0].failed === false, '成功的调用被空壳的失败结果盖成了失败')
      assert(tools[0].result === '搜到了', `结果配错了：${tools[0].result}`)
    })

    await test('浏览器每走一步那张截图：折进消息，摆成一条缩略图', async () => {
      /**
       * 这张图**只在界面上有用**：模型看不见它（默认那个对话模型没有视觉）。也就是说
       * 这条链路断了，不会有任何人抱怨——只有断言看得住。
       */
      const ui = await boot()
      const ev = (seq, type, data) => ({ seq, time: 1, type, data })
      const shot = (n) => ({ path: `browser/s1/2026-${n}-click.jpg`, name: `2026-${n}-click.jpg` })
      const folded = ui.fold([
        ev(1, 'user/message', { message: { content: [{ type: 'text', text: '去看看' }] }, source: { kind: 'user' } }),
        ev(2, 'turn/start', { turn: 1 }),
        ev(3, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'browser_navigate', arguments: '{}' }),
        ev(4, 'tool/result', { turn: 1, step: 1, callId: 'c1', text: '已打开。', failed: false, shot: shot(1) }),
        ev(5, 'tool/call', { turn: 1, step: 2, callId: 'c2', name: 'bash', arguments: '{}' }),
        ev(6, 'tool/result', { turn: 1, step: 2, callId: 'c2', text: 'ok', failed: false }),
        ev(7, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '看完了' }] } }),
        ev(8, 'turn/end', { turn: 1, reason: 'completed' }),
      ])
      const tools = folded.blocks.find((b) => b.kind === 'assistant')?.tools || []
      assert(tools[0]?.shot?.path === 'browser/s1/2026-1-click.jpg', `截图没折进来：${JSON.stringify(tools[0]?.shot)}`)
      // 没拍照的那把工具不该凭空多出一张。
      assert(tools[1]?.shot == null, `没截图的工具被塞了一张：${JSON.stringify(tools[1]?.shot)}`)

      // 老日志没有这个字段，界面要退回「没有」，不能崩。
      assert(!ui.stepShots([{ name: 'bash' }]).length, '没有 shot 的老日志把它弄崩了')
      // 同一张图在一条消息里只摆一次。
      assert(ui.stepShots(tools.concat(tools)).length === 1, '同一张图摆了两次')

      /**
       * **一条消息底下要封顶。** 一次多步浏览轻松走十几步，全摆出来是四五行缩略图，
       * 把真正的回答挤出屏幕。多出来的**不闷声吞掉**——要说清还有多少、去哪儿找。
       */
      const many = Array.from({ length: 20 }, (_, i) => ({ name: 'browser_click', shot: shot(i + 10) }))
      assert(ui.stepShots(many).length === 20, 'stepShots 自己不该截')
      assert(ui.MAX_STEP_SHOTS === 12, `上限变了就来改这条：${ui.MAX_STEP_SHOTS}`)
      const more = ui.stepMoreHtml(8)
      assert(more.includes('8'), `没说清还有多少张：${more}`)
      assert(more.includes('browser/'), `没说清去哪儿找：${more}`)
    })

    await test('读秒：这一轮一开始就在走，第一个字落地时不从头数起', async () => {
      /**
       * 气泡下面那行秒表回答的是「我已经等了多久」。
       *
       * 塌了的样子是这样的：模型先想十几秒（日常任务尤其——它常常先调几把工具），
       * 这期间末尾那条是「正在想」的占位，而占位块原来的 `time` 是 0，于是 paintRowTime
       * 判不出「在跑」，**整行时间被隐掉**；等第一个字落地，秒表才凭空冒出来，还从
       * 「0s」数起——人看到的就是这一行忽有忽无、而且已经等了十几秒却写着刚开始。
       */
      const ui = await boot()
      const t0 = 1787700000000
      const ev = (seq, time, type, data) => ({ seq, time, type, data })
      const head = [
        ev(1, t0, 'user/message', { message: { content: [{ type: 'text', text: '理一遍今天的新闻' }] }, source: { kind: 'user' } }),
        ev(2, t0 + 1000, 'turn/start', { turn: 1 }),
      ]
      const thinking = ui.fold(head)
      assert(thinking.status === 'running', `该是忙态：${JSON.stringify(thinking.status)}`)
      assert(thinking.statusAt === t0 + 1000, `这一轮的起点取错了：${thinking.statusAt}`)
      const rows = ui.threadRows(thinking, 's-clock')
      const live = rows[rows.length - 1]
      assert(live.key === 'm-live', `末尾该是「正在想」那条占位：${live.key}`)
      assert(live.block.time === thinking.statusAt, '占位块没带上这一轮的起点，那一行时间会被整个隐掉')

      // 第一个字落地：秒表的起点仍然是 turn/start，不是这一块自己的时间。
      const typing = ui.fold([...head, ev(3, t0 + 13000, 'assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: '今天' } })])
      assert(typing.statusAt === t0 + 1000, `起点被第一个字挪走了：${typing.statusAt}`)
      const block = typing.blocks[typing.blocks.length - 1]
      assert(block.kind === 'assistant' && block.time === t0 + 13000, '这一块自己的时间该是第一个字那一刻')

      const node = {
        hidden: true,
        textContent: '',
        attrs: {},
        setAttribute(k, v) {
          this.attrs[k] = String(v)
        },
        removeAttribute(k) {
          delete this.attrs[k]
        },
        getAttribute(k) {
          return k in this.attrs ? this.attrs[k] : null
        },
      }
      ui.paintRowTime({ querySelector: () => node }, block, true, typing.statusAt)
      assert(node.hidden === false, '在跑的那一行时间被隐掉了')
      assert(node.attrs['data-running'] === '1', '没标成在读秒，心跳就不会来推它')
      assert(node.attrs['data-since'] === String(t0 + 1000), `秒表从第一个字数起了：${node.attrs['data-since']}`)

      // 占位那条同样要画得出来（它和上面是同一个 since）。
      const node2 = { ...node, attrs: {}, hidden: true }
      ui.paintRowTime({ querySelector: () => node2 }, live.block, true, thinking.statusAt)
      assert(node2.hidden === false, '「正在想」的时候那一行时间还是被隐掉了')

      /**
       * 上一轮收口了、席位却说「在跑」（live 旗子压过扫出来的结论，新那条 turn/start
       * 还在路上）：起点**不能**还是上一轮的。留着的话，早上跑完一轮、晚上日常任务
       * 起来的那一帧，气泡下面直接是个十几个小时的数字。
       */
      const done = [...head, ev(3, t0 + 20000, 'assistant/message', { message: { content: [{ type: 'text', text: '好了' }] } }), ev(4, t0 + 21000, 'turn/end', { turn: 1, reason: 'completed' })]
      assert(ui.fold(done).statusAt === 0, '收口了还留着这一轮的起点')
      const relive = ui.fold(done, true)
      assert(relive.status === 'running', 'live 旗子该压过扫出来的结论')
      assert(relive.statusAt === t0 + 21000, `起点该退到最后一条事件，实际 ${relive.statusAt - t0}ms`)
    })

    await test('日常模型备选：任何供应商的模型都能加，不只平台存了密钥的那一家', async () => {
      /**
       * 备选本来就是「换一家的模型试试」。按平台密钥表筛候选的话，只存了一家密钥（其余的
       * 走环境变量、或者还没存）的平台上，下拉框里就只剩当前那一家——人想加别家的模型，
       * 界面上根本找不到入口。
       */
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: 'ui-smoke-token',
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
      })
      ui.state.me = { account: { id: 'o', role: 'owner', name: 'O' }, settings: {} }
      ui.state.path = '/models'
      ui.state.catalog = [
        { provider: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }, { id: 'deepseek-r2', name: 'DeepSeek R2' }] },
        { provider: 'openrouter', name: 'OpenRouter', models: [{ id: 'qwen/qwen3', name: 'Qwen3' }] },
      ]
      ui.state.creds = [{ provider: 'deepseek', configured: true }]
      ui.state.settings = { daily: { provider: 'deepseek', model: 'deepseek-v4' }, utility: { provider: '', model: '' }, dailyAlternates: [], enabledModels: [] }
      ui.state.selectedProvider = 'deepseek'
      ui.render()
      const first = ui.html()
      assert(/data-act="alt-provider"[\s\S]*value="openrouter"/.test(first), `别家供应商不在备选的供应商下拉里：${first.slice(0, 300)}`)
      assert(first.includes('value="deepseek/deepseek-r2"'), '存了密钥的那家排在前面、默认展开')
      ui.state.altProvider = 'openrouter'
      ui.render()
      assert(ui.html().includes('value="openrouter/qwen/qwen3"'), '换到别家之后，那家的模型没列出来')
    })

    await test('日常任务跑着的时候，轮询没变化就一下都不重画', async () => {
      /**
       * 这一栏挂在**对话页**上，而它的轮询只在「有一轮正在跑」时才转——也就是说，
       * 「试跑的这几十秒」正好是整页每 4 秒被重绘一次的几十秒。`render()` 是
       * `#app` 的 innerHTML 整块换掉：正在流式输出的 Markdown 全部重渲染、图片重新
       * 加载、贴底状态（data-touched 在被换掉的那个节点上）跟着丢，气泡下面那行读秒
       * 也被拆了重建。人看到的就是「一跑起来整块就开始抖」。
       *
       * 而这几十秒里这一栏其实什么都没变：那一行一直写着「正在跑…」。
       */
      const run = (over) => ({ id: 'run1', trigger: 'manual', status: over ? 'ok' : 'running', sessionId: 's1', error: null, startedAt: 1, endedAt: over ? 2 : null })
      const routine = { id: 'rt1', botId: 'b1', name: '每日简报', instruction: '理一遍', active: true, triggers: [], modelRole: 'utility', nextRunAt: null, lastRun: run(false), createdAt: 1, updatedAt: 1 }
      let over = false
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: 'ui-smoke-token',
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ routine, runs: [run(over)] }) }),
      })
      // 不在对话页：轮询定时器就不会起，测试进程也不会被它吊着。
      ui.state.path = '/'
      ui.state.routinesBotId = 'b1'
      ui.state.routineOpen = 'rt1'
      ui.state.routines = [routine]
      ui.state.routineRuns = [run(false)]

      // 第二个参数就是「这一下是那根 4 秒的定时器打来的」——跳过重画只对它生效。
      ui.app.innerHTML = 'SENTINEL'
      await ui.refreshRoutine('rt1', true)
      assert(ui.html() === 'SENTINEL', '没变化也重画了整页——对话页上这就是每 4 秒把正在输出的正文连根拔一次')

      // 跑完了是真变化，这一下必须画：不画的话那一行会一直转着圈。
      over = true
      await ui.refreshRoutine('rt1', true)
      assert(ui.html() !== 'SENTINEL', '跑完了却没重画，界面上那条会一直停在「正在跑」')

      /**
       * **不是轮询的调用一律照画。** `sendRoutinePatch` 存不下去时先写下
       * `state.routineError`、再把重画交给这里——那时快照里已经带着那句错误，按
       * 「没变化就不画」判就是一下都不画：屏上没有红字，输入框里还留着没存下的内容。
       */
      ui.state.routineError = '存不下去了'
      ui.app.innerHTML = 'SENTINEL2'
      await ui.refreshRoutine('rt1')
      assert(ui.html() !== 'SENTINEL2', '保存失败之后那次对账没重画——那句错误就永远到不了屏上')
    })

    await test('日常任务列表：另一个标签页改了跑的时间，这边要跟上', async () => {
      // 快照只比触发器**条数**的话，「每天 09:00」改成「每天 21:00」条数没变，
      // 列表那一行小字（rtWhenText 读的正是触发器内容）就一直停在旧时间上。
      const trigger = (at) => ({ kind: 'schedule', every: 'day', at, weekday: 1, day: 1, tz: 'UTC' })
      let at = '09:00'
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: 'ui-smoke-token',
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ routines: [{ id: 'rt1', name: '每日简报', active: true, triggers: [trigger(at)], nextRunAt: 999, lastRun: { id: 'r1', status: 'running' } }] }),
        }),
      })
      ui.state.path = '/'
      ui.state.routinesBotId = 'b1'
      ui.state.routines = [{ id: 'rt1', name: '每日简报', active: true, triggers: [trigger('09:00')], nextRunAt: 999, lastRun: { id: 'r1', status: 'running' } }]

      ui.app.innerHTML = 'SENTINEL'
      await ui.refreshRoutineList()
      assert(ui.html() === 'SENTINEL', '一模一样也重画了整页')

      at = '21:00'
      await ui.refreshRoutineList()
      assert(ui.html() !== 'SENTINEL', '跑的时间改了却不重画，那一行会一直写着旧时间')
    })

    await test('确认卡：还等着的摊开，有结论的收成药丸', async () => {
      /**
       * 摊开是给「你要批的到底是什么」用的——参数看不见就只能凭信任点。可人点完之后
       * 它就只是一条痕迹了，还占着半屏参数的话，往上翻这一轮会被几张已经作废的卡片挡住。
       */
      const ui = await boot()
      const ev = (seq, type, data) => ({ seq, time: 1, type, data })
      const approval = (seq, callId, state) =>
        ev(seq, 'tool/approval', {
          callId,
          name: 'mcp_github_default_sw_run',
          arguments: '{"tool":"GITHUB_FIND_REPOSITORIES","args":{"per_page":50}}',
          reason: 'mcp_github_default_sw_run 会往外部系统写入或发送内容',
          state,
          ...(state === 'pending' ? { expiresAt: 2 } : {}),
        })
      const folded = ui.fold([
        ev(1, 'turn/start', { turn: 1 }),
        ev(2, 'tool/call', { turn: 1, step: 1, callId: 'call_a', name: 'mcp_github_default_sw_run', arguments: '{}' }),
        approval(3, 'call_a', 'pending'),
        approval(4, 'call_a', 'approved'),
        approval(5, 'call_b', 'pending'),
      ])
      const apps = folded.blocks.find((b) => b.kind === 'assistant')?.approvals || []
      assert(apps.length === 2, `两条确认该各留一条：${JSON.stringify(apps.map((a) => a.state))}`)
      // 同一个 callId 来两条（pending 之后是终态），取最后一条。
      assert(apps[0].state === 'approved' && apps[1].state === 'pending', JSON.stringify(apps.map((a) => a.state)))

      const chip = ui.approvalChipHtml(apps[0], 1)
      assert(chip.includes('sw-approvalchip'), '收起来的那条没画成药丸')
      assert(chip.includes('已批准'), `药丸上没写结论：${chip}`)
      // 药丸上**不许**带参数：整段 JSON 摊在气泡里，正是这次要收掉的东西。
      assert(!chip.includes('GITHUB_FIND_REPOSITORIES'), '药丸把参数也带出来了')
      assert(chip.includes('data-i="1"'), `下标要接在工具药丸后面数：${chip}`)

      // 参数没丢，只是挪进了悬浮窗——和工具痕迹同一个交互。
      const pop = ui.toolPopBody(ui.approvalPop(apps[0]))
      assert(pop.includes('GITHUB_FIND_REPOSITORIES'), '悬浮窗里看不到当时批的参数')
      assert(pop.includes('会往外部系统写入'), '悬浮窗里没说为什么要确认')

      // 还等着的那条照旧摊开，按钮都在。
      const card = ui.approvalHtml(apps[1])
      assert(card.includes('data-act="chat-approve"') && card.includes('data-act="chat-deny"'), '等着的那张卡没有按钮')
      assert(card.includes('GITHUB_FIND_REPOSITORIES'), '等着的那张卡没把参数摆出来')
      assert(ui.approvalState(apps[0]) === 'approved', '状态认错了')
    })

    await test('交接卡：状态一路变，交还那句话画成人说的', async () => {
      /**
       * 转人工的闭环在界面这一侧有三处会**静默**坏掉（见 docs/handoff.md §11）：
       * 单子折不出来、状态变了卡片不重画、交还那条消息被当成非人类消息滤掉。
       * 三处都不报错，看到的只是「Bot 自己开口接着干活」或者「点了接手没反应」。
       */
      const ui = await boot()
      const ev = (seq, type, data) => ({ seq, time: 1, type, data })
      const ho = (seq, state, extra = {}) =>
        ev(seq, 'human/handoff', {
          id: 'h1',
          callId: 'c1',
          state,
          reason: '这笔付款超出我的权限',
          ask: '去财务系统里把这笔付了',
          blocking: true,
          ...extra,
        })
      const folded = ui.fold([
        ev(1, 'user/message', { message: { content: [{ type: 'text', text: '把这笔付了' }] }, source: { kind: 'user' } }),
        ev(2, 'turn/start', { turn: 1 }),
        ev(3, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '我付不了，交给人' }] } }),
        ho(4, 'open'),
        ev(5, 'turn/end', { turn: 1, reason: 'completed' }),
        ho(6, 'claimed', { claimedBy: { accountId: 'u1', name: '张三' } }),
        ev(7, 'user/message', {
          message: { content: [{ type: 'text', text: '【转人工交还】张三 已经处理完…' }] },
          source: { kind: 'plugin', plugin: 'handoff' },
        }),
      ])
      const block = folded.blocks.find((b) => (b.handoffs || []).length)
      assert(block, '交接单没折出来')
      const hs = block.handoffs
      // 同一张单来两条，取最后一条——和确认卡是同一套读法。
      assert(hs.length === 1 && hs[0].state === 'claimed', `状态没跟上：${JSON.stringify(hs.map((h) => h.state))}`)
      assert(hs[0].claimedBy && hs[0].claimedBy.name === '张三', '接手人没带出来')

      const card = ui.handoffHtml(hs[0])
      // 卡上最大的那行字是「要人做什么」：接手的人先要知道自己该干嘛。
      assert(card.includes('去财务系统里把这笔付了'), `卡上没有要人做什么：${card}`)
      assert(card.includes('data-act="chat-handoff-return"'), '交还的按钮不在')
      assert(card.includes('sw-handoff-note'), '写结论的框不在——那句话是 Bot 接着做的全部依据')
      // 已经接手了就不该再有「我来接手」。
      assert(!card.includes('chat-handoff-claim'), '已经有人接了还画着「我来接手」')
      assert(ui.handoffDoneHtml({ state: 'expired' }).includes('没人接手'), '闭合那一行没说清是怎么结束的')

      /**
       * **交还那条消息要画出来。** 它的 source 是 plugin/handoff，而 fold 默认滤掉
       * 非人类消息——滤掉的话，界面上就是 Bot 突然自己开口接着干活，而上一句是几小时前
       * 它说「等人接手」。
       */
      const said = folded.blocks.filter((b) => b.kind === 'user').map((b) => b.text)
      assert(said.some((t) => t.includes('转人工交还')), `交还那条被滤掉了：${JSON.stringify(said)}`)
    })

    await test('交接卡：按钮真的派发请求，失败不能静默成“点不动”', async () => {
      /**
       * 以前只断言 handoffHtml 里存在 data-act，没真正向 #app 派发 click。于是按钮画得
       * 完全正常，但失败分支只改 state.error、不 render，用户看到的就是点了没反应。
       */
      const calls = []
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: 'ui-handoff-token',
        fetchImpl: async (path, init) => {
          calls.push({ path, method: init?.method || 'GET' })
          return new Response(JSON.stringify({ error: '席位没应答：测试断线' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        },
      })
      ui.app.innerHTML = 'before-click'
      await ui.fire('click', el('button', { 'data-act': 'chat-handoff-claim', 'data-id': 'h-click' }))
      assert(
        calls.some((c) => c.method === 'POST' && c.path === '/runtime/handoffs/h-click/claim'),
        `点击没有进入转人工接口：${JSON.stringify(calls)}`,
      )
      assert(ui.state.error.includes('席位没应答'), `失败原因没有留下：${ui.state.error}`)
      assert(ui.html() !== 'before-click', '失败后没有重绘，界面仍表现成按钮点不动')
    })

    await test('交接卡：中间隔了几轮对话，也还是同一张卡', async () => {
      /**
       * 一张单的后续状态常常隔几小时才来，那时人多半又跟 Bot 说过话——「当前这一块」
       * 早就不是开单那一块了。只在当前块里按 id 找的话，claimed 会被当成一张新单推进
       * 新块：**同一张单画出两张卡**，上面那张还写着「等人接手」、按钮还能点（点下去
       * 换回 409），而人在下面那张卡里写的结论也读不到（取的是第一个匹配的输入框）。
       */
      const ui = await boot()
      const ev = (seq, type, data) => ({ seq, time: 1, type, data })
      const ho = (seq, state, extra = {}) =>
        ev(seq, 'human/handoff', { id: 'h1', callId: 'c1', state, reason: 'r', ask: '去把这笔付了', blocking: true, ...extra })
      const folded = ui.fold([
        ev(1, 'user/message', { message: { content: [{ type: 'text', text: '把这笔付了' }] }, source: { kind: 'user' } }),
        ev(2, 'turn/start', { turn: 1 }),
        ev(3, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '我付不了' }] } }),
        ho(4, 'open'),
        ev(5, 'turn/end', { turn: 1, reason: 'completed' }),
        // 人在等的时候又跟 Bot 聊了两句——真实得很
        ev(6, 'user/message', { message: { content: [{ type: 'text', text: '那先放着' }] }, source: { kind: 'user' } }),
        ev(7, 'turn/start', { turn: 2 }),
        ev(8, 'assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: '好' }] } }),
        ev(9, 'turn/end', { turn: 2, reason: 'completed' }),
        ho(10, 'claimed', { claimedBy: { accountId: 'u1', name: '张三' } }),
      ])
      const cards = folded.blocks.flatMap((b) => b.handoffs || [])
      assert(cards.length === 1, `同一张单画了 ${cards.length} 次：${JSON.stringify(cards.map((h) => h.state))}`)
      assert(cards[0].state === 'claimed', `状态没跟上：${cards[0].state}`)
      // 认回的是**开单那一块**，人往上翻会在那儿找到它。
      const owner = folded.blocks.findIndex((b) => (b.handoffs || []).length)
      assert(owner === 1, `卡片挂错了块：${owner}`)
    })

    await test('待办页：别人名下的 Bot 打不开对话，就地给一张能处理的卡', async () => {
      /**
       * `/runtime/bots/:id` 按「这颗 Bot 是不是你的」判（visibleBotOf），管理员点别人的
       * 单子会落在一句「没有这个 Bot」上——而管理员恰恰是这套东西里最该处理别人单子的人。
       */
      const ui = await boot()
      ui.state.me = { account: { id: 'me', companyId: 'c1', role: 'admin' } }
      const row = (extra) => ({
        id: 'h1', botId: 'b1', sessionId: 's1', state: 'open',
        ask: '去财务系统里把这笔付了', reason: '超出我的权限', createdAt: 1,
        ownerName: '张三', assignee: null, claimedBy: null, ...extra,
      })

      // 自己的 Bot：给「去对话里处理」，那条路走得通。
      const own = ui.handoffRow(row({ accountId: 'me' }))
      assert(own.includes('data-act="handoff-open"'), '自己的 Bot 该给去对话的入口')

      // 别人的 Bot：不许给那颗按钮，否则点过去是一句「没有这个 Bot」。
      const other = ui.handoffRow(row({ accountId: 'someone-else' }))
      assert(!other.includes('data-act="handoff-open"'), '别人的 Bot 还给了打不开的入口')
      assert(other.includes('data-act="handoff-detail"'), '别人的 Bot 没有就地处理的入口')

      // 展开之后要有能写结论的框和交还按钮，而且正文没拉到时说清楚是席位没应答。
      ui.state.handoffOpenId = 'h1'
      ui.state.handoffDetail = { h1: null }
      const open = ui.handoffRow(row({ accountId: 'someone-else' }))
      assert(open.includes('sw-handoff-note'), '就地处理却没有写结论的框')
      assert(open.includes('data-act="chat-handoff-return"'), '就地处理却交还不了')
      assert(open.includes('席位没应答'), `正文拉不到时没说清是怎么回事：${open.slice(-400)}`)
      // 拉到了就把 Bot 做到哪一步摆出来——接手的人靠它不用从头问一遍。
      ui.state.handoffDetail = { h1: { id: 'h1', summary: '已经查到发票号 A-991' } }
      assert(ui.handoffRow(row({ accountId: 'x' })).includes('A-991'), '拉到了正文却没画出来')
    })

    await test('席位上已经没有的那张单：画成一行字，不留按钮', async () => {
      /**
       * 交接单是落盘的，但席位重装 / 换机器 / 手工清过库之后，日志里那条 open 还在而
       * 单子已经没了。照着日志画出来的卡片带着一整排按钮，点下去只换回一句 409。
       */
      const ui = await boot()
      const ev = (seq, type, data) => ({ seq, time: 1, type, data })
      const folded = ui.fold([
        ev(1, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '交给人' }] } }),
        ev(2, 'human/handoff', { id: 'h9', callId: 'c9', state: 'open', reason: 'r', ask: '去把这笔付了', blocking: true }),
      ])
      const card = (folded.blocks.find((b) => (b.handoffs || []).length) || {}).handoffs[0]
      ui.state.chatSessionId = 's-x'
      // 核对回来的清单里没有它，而它落盘的行号（seq=2）比水位早。
      ui.state.chatHandoffs = { sessionId: 's-x', ids: new Set(['别的单']), upto: 5 }
      assert(ui.handoffDead(card), '席位说没有这张单了，界面还当它活着')
      assert(!ui.handoffDoneHtml(card).includes('chat-handoff-return'), '失效的还留着按钮')
      assert(ui.handoffDoneHtml(card).includes('席位'), `失效那行没说清是怎么回事：${ui.handoffDoneHtml(card)}`)
      // 席位还没答话（没有快照）时**不许**判失效：那会让人以为不用管它。
      ui.state.chatHandoffs = null
      assert(!ui.handoffDead(card), '没拿到现况就把一件真在等人的事画成了失效')
    })

    await test('发信的确认走定制卡：能读、能改，别的参数也露着', async () => {
      /**
       * 通用卡把整份 JSON 摊出来，而人在批一封信时要看的是「发给谁、写了什么」。更要紧
       * 的是**得能改**：模型起草的正文十有八九要动一两句，只能批准/拒绝的话，人就得
       * 拒掉再去跟它解释，而它下一稿仍然是它写的。
       */
      const ui = await boot()
      const form = {
        kind: 'email',
        tool: 'GMAIL_SEND_EMAIL',
        fields: [
          { key: 'args.recipient_email', label: '收件人', value: 'a@b.c' },
          { key: 'args.subject', label: '主题', value: '二季度报表', editable: true },
          { key: 'args.body', label: '正文', value: '你好，附件是报表。', editable: true, multiline: true },
          { key: 'args.is_html', label: 'is_html', value: 'false' },
        ],
      }
      const card = ui.approvalHtml({
        callId: 'call_mail',
        name: 'mcp_gmail_default_sw_run',
        args: '{}',
        reason: 'GMAIL_SEND_EMAIL 会往外部系统写入或发送内容',
        state: 'pending',
        form,
      })
      assert(card.includes('sw-approval-mail'), '发信没走定制卡')
      assert(card.includes('收件人') && card.includes('a@b.c'), '收件人没摆出来')
      // 只读的那几格照样露着：藏起来的话，人以为自己看到了这封信的全部。
      assert(card.includes('is_html'), '别的参数被藏起来了')
      // 收件人不能改：那是「在这儿写封信」，不是「审一眼要发出去的东西」。
      assert(!card.includes('data-edit="args.recipient_email"'), '收件人被做成可改的了')
      assert(card.includes('data-edit="args.subject"'), '主题不让改')
      assert(card.includes('<textarea') && card.includes('data-edit="args.body"'), '正文没做成可编辑的多行框')
      assert(card.includes('你好，附件是报表。'), '正文没填进去')
      assert(card.includes('批准并发送'), `发信那张卡的按钮该说清楚它要干什么：${card.slice(-400)}`)
      /**
       * 第二颗按钮的范围是**一轮**，不是一条会话。
       *
       * 一个 Bot 一辈子只有一条会话，按会话放行等于永久通行证；按钮上的话必须跟真实
       * 范围对得上，否则它就是在替人做一个他没同意的决定。
       */
      assert(card.includes('data-scope="turn"'), '「都批准」那颗按钮的范围不是一轮')
      assert(card.includes('这一轮都批准') && !card.includes('这次对话都批准'), '按钮上的话还在说「这次对话」')
      // 拒绝那一侧也有一颗带范围的，和批准那一对对称。
      assert(card.includes('data-act="chat-deny" data-call="call_mail" data-scope="turn"'), '没有「这一轮别再试」那颗按钮')
      assert(card.includes('这一轮别再试'), '拒绝那一侧缺了带范围的那颗')
      // 剥壳之后的工具名才认得出来，sw_run 谁也看不出是什么。
      assert(card.includes('GMAIL_SEND_EMAIL'), '卡片上没写真正要跑的那把工具')

      // 认不出的 kind 一律退回通用卡——新增一种表单不该让老版本白屏。
      const generic = ui.approvalHtml({
        callId: 'c2', name: 'mcp_x_y', args: '{"a":1}', reason: 'x', state: 'pending',
        form: { kind: '将来才有的一种', tool: 'X', fields: [] },
      })
      assert(!generic.includes('sw-approval-mail') && generic.includes('sw-approval-args'), '认不出的 kind 没退回通用卡')

      // 收起来那颗药丸上写真工具名，改过还要标一笔。
      const chip = ui.approvalChipHtml({ callId: 'call_mail', name: 'mcp_gmail_default_sw_run', state: 'approved', form, edited: ['正文'] }, 0)
      assert(chip.includes('GMAIL_SEND_EMAIL'), `药丸上还是壳的名字：${chip}`)
      assert(chip.includes('已改'), '改过的没在药丸上标出来')
      const pop = ui.toolPopBody(ui.approvalPop({ callId: 'call_mail', name: 'x', args: '{}', state: 'approved', form, edited: ['正文'] }))
      assert(pop.includes('批准时改过') && pop.includes('正文'), '悬浮窗没说这次改过哪几格')
      assert(pop.includes('你好，附件是报表。'), '悬浮窗里看不到最终发出去的内容')

      // HTML 邮件默认看渲染后的效果，不把一屏标签原样糊到批准人脸上；源码仍能展开改。
      const htmlForm = {
        ...form,
        fields: form.fields.map((field) => field.key === 'args.body'
          ? { ...field, value: '<p>你好，<b>账单见下表</b></p><script>parent.postMessage("x", "*")</script>' }
          : field.key === 'args.is_html' ? { ...field, value: 'true' } : field),
      }
      const htmlCard = ui.approvalHtml({
        callId: 'call_html_mail', name: 'mcp_gmail_default_sw_run', args: '{}', reason: 'send', state: 'pending', form: htmlForm,
      })
      assert(htmlCard.includes('class="sw-mail-preview"'), 'HTML 正文没有显示预览')
      assert(htmlCard.includes('sandbox=""') && htmlCard.includes('referrerpolicy="no-referrer"'), 'HTML 预览没有隔离')
      assert(htmlCard.includes('Content-Security-Policy') && htmlCard.includes('default-src'), 'HTML 预览没有阻断远程资源')
      assert(htmlCard.includes('<details class="sw-mail-source">'), 'HTML 源码没有保留可编辑入口')
      assert(htmlCard.includes('data-edit="args.body"'), 'HTML 源码编辑框没有沿用批准参数')
      assert(!htmlCard.includes('<script>parent.postMessage'), '邮件 HTML 被直接注入了批准页')
      assert(htmlCard.includes('&lt;script&gt;parent.postMessage'), '邮件源码转义后丢了')
      // is_html=false 的普通邮件仍是直接编辑正文，不能也被误画成 iframe。
      assert(!card.includes('sw-mail-preview'), '纯文本邮件被误判成 HTML')
    })

    await test('消息里的 @ 点名要留在气泡上，别发完就没', async () => {
      // 点名是消息的一部分（它决定了这一轮的工具表），不是输入框上一个发完就没的装饰。
      // 丢掉的话翻上去看昨天那条，「@ 了谁」就消失了——而那正是「它为什么去读了我的
      // 邮箱」的唯一答案。落盘的是结构块，正文里一个字都没有，所以只能从块里取。
      const ui = await boot()
      const folded = ui.fold([
        {
          seq: 1,
          time: 1,
          type: 'user/message',
          data: {
            source: { kind: 'user' },
            message: {
              content: [
                { type: 'mention', kind: 'connector', id: 'conn-1', label: 'Gmail (default)' },
                { type: 'text', text: '查看邮件' },
              ],
            },
          },
        },
      ])
      const b = folded.blocks[0]
      assert(b && b.kind === 'user', '用户那条没折出来')
      assert(b.text === '查看邮件', `正文被点名块弄脏了：${b.text}`)
      assert((b.mentions || []).length === 1, `点名没跟着消息留下来：${JSON.stringify(b.mentions)}`)
      assert(b.mentions[0].label === 'Gmail (default)', `药丸上的名字不对：${b.mentions[0].label}`)
      // 气泡那一层是真 DOM（垫片里画不出来），这里只钉住它确实画了这排药丸。
      const src = readFileSync(join(root, 'gateway/ui/chat.js'), 'utf8')
      assert(src.includes('sw-mentions-in'), '气泡里没有画点名药丸的那一排')
    })

    await test('工具浮层：在它自己身上滚不算「页面滚了」，不许收掉', async () => {
      // 这一条只验源码。滚动收浮层挂在 window 的**捕获阶段**，垫片里 window 是个空壳，
      // 事件根本发不出去——但错法就藏在那一行里：不看事件源头，滚浮层自己的结果区
      // （`.sw-toolpop pre`，最高 220px）也照收，手一动窗口就没了，长输出永远看不完。
      const src = readFileSync(join(root, 'gateway/ui/chat.js'), 'utf8')
      // chat.js 里不止一个捕获阶段的 scroll 监听，认收浮层的那一个。
      const handler = [...src.matchAll(/addEventListener\(\s*'scroll',([\s\S]*?),\s*true,?\s*\)/g)]
        .map((m) => m[1])
        .find((h) => h.includes('hideToolPop'))
      assert(handler !== undefined, '找不到收浮层的那个 scroll 监听')
      assert(handler.includes('sw-toolpop'), '滚动收浮层时没有区分事件源头，滚浮层自己也会把它收掉')
    })

    await test('机器失联：抬头那盏灯不许还写着「在线」，正文里要说清楚为什么', async () => {
      /**
       * 这一条钉的是那次报障：平台那一页已经把灯打成「失联」，员工手上的 Bot 还挂着
       * 「在线」——因为界面那盏灯看的是席位的部署状态（`ready`），而它落库之后就不动
       * 了，答不了「那台机器现在通不通」。
       *
       * 灯的判断和横幅都不碰 DOM，就地拿函数验：垫片里没有 lastElementChild 可写。
       */
      const ui = await boot()
      const bot = (link, age) => [{ id: 'b1', name: '小满', runtime: { status: 'ready', machineLink: link, machineHeartbeatAge: age } }]
      ui.state.me = { account: { id: 'me', companyId: 'c1', role: 'member', email: 'm@x' }, company: { id: 'c1' } }
      ui.state.path = '/a/b1'
      ui.state.chatBotId = 'b1'
      ui.state.desktopRuntime = { status: 'ready', seatId: 'seat-1' }

      // 机器好着：照旧是「在线」，忙的时候是「正在处理」。
      ui.state.runtimeBots = bot('online', 1200)
      assert(ui.liveLamp(false).text === '在线', `机器在线时该说在线，得到 ${ui.liveLamp(false).text}`)
      assert(ui.liveLamp(true).state === 'busy', `在跑的时候该是 busy，得到 ${ui.liveLamp(true).state}`)
      assert(ui.machineDownBanner() === '', '机器好着却弹了失联横幅')

      // 失联：灯要改口，**连「正在处理」都压过去**——那一句是断线之前留在手上的，
      // 挂着它等于告诉人「它还在替你干活」。
      ui.state.runtimeBots = bot('offline', 12 * 60_000)
      assert(ui.liveLamp(false).text === '失联', `失联时灯说的是「${ui.liveLamp(false).text}」`)
      assert(ui.liveLamp(true).text === '失联', '还在跑的那一轮把失联盖掉了')
      assert(ui.liveLamp(false).state === 'offline', `灯的档位 ${ui.liveLamp(false).state}`)
      const banner = ui.machineDownBanner()
      assert(banner.includes('小满'), `横幅没说是谁的机器：${banner}`)
      assert(banner.includes('失联') && banner.includes('12 分钟前'), `横幅没说多久没心跳了：${banner}`)
      assert(banner.includes('发不出去'), `横幅没说清这期间会怎样：${banner}`)

      // 心跳迟了是中间那一档：灯变，**但不出横幅**——换版重启就落在这个窗口里，
      // 出红字等于每次自升级都喊一次狼来了。
      ui.state.runtimeBots = bot('stale', 5 * 60_000)
      assert(ui.liveLamp(false).text === '心跳迟了', `迟了那一档说的是「${ui.liveLamp(false).text}」`)
      assert(ui.machineDownBanner() === '', '心跳迟了不该弹红字横幅')

      // 后端还没给这个字段（前端比后端新一步）：不许猜成失联，照旧按部署状态走。
      ui.state.runtimeBots = [{ id: 'b1', name: '小满', runtime: { status: 'ready' } }]
      assert(ui.liveLamp(false).text === '在线', '字段缺席时被猜成了失联')
      assert(ui.machineDownBanner() === '', '字段缺席时弹了失联横幅')

      // 本地 Bot 不装远程桌面。隧道在线就是「本机运行中」，不能因为 desktopRuntime
      // 为空而显示离线；真停了也说「本机未运行」，不冒充远程机器失联。
      ui.state.desktopRuntime = null
      ui.state.runtimeBots = [{
        id: 'b1', name: '小满', runtimeKind: 'local',
        runtime: { kind: 'local', status: 'ready', machineLink: 'online' },
      }]
      assert(ui.liveLamp(false).text === '本机运行中', `本地隧道在线却显示「${ui.liveLamp(false).text}」`)
      assert(ui.liveLamp(false).state === '1', '本地隧道在线没有使用绿色在线态')
      assert(ui.liveLamp(true).state === 'busy', '本地 Bot 工作时没有进入正在处理态')
      ui.render()
      assert(ui.html().includes('class="satu-localtag">本地 Bot</span>'), '会话顶栏没有醒目的本地 Bot 徽标')
      assert(ui.html().includes('class="satu-localtag" data-compact>本地</span>'), '侧栏没有本地徽标')

      ui.state.runtimeBots[0].runtime = { kind: 'local', status: 'none', machineLink: 'offline' }
      assert(ui.liveLamp(false).text === '本机未运行', `本地 Bot 停止后显示「${ui.liveLamp(false).text}」`)
      assert(ui.machineDownBanner() === '', '本地 Bot 停止后不该弹远程机器失联横幅')
    })

    await test('建完 Bot 那一屏：说得出在装第几步、装了多久，装好之前不给按钮', async () => {
      /**
       * 建 Bot 现在建完就开装（服务端顺手开的），所以这一屏取代了原来那句「还没有部署
       * ＋一颗按钮」。它要答的是人此刻唯一的问题：**这是正常的等，还是卡住了。**
       *
       * 三样缺一不可：在装什么、装了多久、装好之后会怎样。而那颗「部署这个 Bot」按钮
       * **不许出现**——机器已经在装了，再点一次只会把它重铺一遍。
       */
      const ui = await boot()
      ui.state.me = { account: { id: 'me', companyId: 'c1', role: 'member', email: 'm@x' }, company: { id: 'c1' } }
      ui.state.path = '/a/b9'
      ui.state.chatBotId = 'b9'
      ui.state.runtimeMachine = { paired: true }
      ui.state.runtimeBots = [{ id: 'b9', name: '新助手', runtime: { status: 'deploying' } }]
      // **席位那一份故意留空**：刚建完的那颗 Bot，/runtime/desktop 完全可能还是 404，
      // 而这一屏必须照样说得出「在装」——否则人看到的是一句「还没有部署」加一颗按钮。
      ui.state.desktopRuntime = null
      ui.state.deployProgress = {
        botId: 'b9',
        status: 'deploying',
        phase: 'installing',
        // 本地锚点（pollDeployProgress 收到服务端那份年龄时算的），读秒照它走。
        since: Date.now() - 200_000,
        lastError: null,
        step: { step: 3, total: 7, label: '安装浏览器', at: Date.now() },
      }
      assert(ui.seatStage() === 'deploying', `席位状态 ${ui.seatStage()}`)
      const html = ui.chatDeployPrompt('b9')
      assert(html.includes('正在安装「新助手」'), `没说在装谁：${html}`)
      assert(html.includes('第 3 步') && html.includes('共 7 步'), `没说第几步：${html}`)
      assert(html.includes('安装浏览器'), `没说在装什么：${html}`)
      assert(html.includes('3:20'), `没说装了多久：${html}`)
      assert(html.includes('sw-install-bar'), `没画进度条：${html}`)
      assert(!html.includes('runtime-deploy'), `装着的时候还摆了部署按钮：${html}`)

      // 老管家报不出第几步（协议低于 3）：话照说，**但整根条子不画**——一根不动的
      // 条比没有条更像卡住了。
      ui.state.deployProgress = { ...ui.state.deployProgress, step: null }
      const coarse = ui.chatDeployPrompt('b9')
      assert(coarse.includes('机器上正在安装'), `粗进度没说话：${coarse}`)
      assert(!coarse.includes('sw-install-bar'), `没有步数还画了条子：${coarse}`)
      assert(coarse.includes('3:20'), `粗进度也得有读秒：${coarse}`)

      // 登记完还没发出去那一档，说的是另一句话。
      ui.state.deployProgress = { ...ui.state.deployProgress, phase: 'queued' }
      assert(ui.chatDeployPrompt('b9').includes('正在下发到机器'), '排队那一档没说清')

      // 装到一半没人管了（Gateway 重启过）：**必须改口**，而且要给一颗能按的按钮。
      // 混在「正在安装」里的话，人守着的是一屏永远走不完的读秒。
      ui.state.deployProgress = { ...ui.state.deployProgress, phase: 'installing', step: null, stale: true }
      assert(ui.seatStage() === 'stalled', `没认出中断：${ui.seatStage()}`)
      const stalled = ui.chatDeployPrompt('b9')
      assert(stalled.includes('上一次安装没做完'), `没改口：${stalled}`)
      assert(stalled.includes('runtime-deploy'), `中断了却没给按钮：${stalled}`)
      assert(!stalled.includes('sw-install-bar'), `中断了还画着进度条：${stalled}`)

      // 装好了：这一屏整个让位给对话（chatPage 据此决定画不画输入框）。
      ui.state.deployProgress = { botId: 'b9', status: 'ready', phase: null, since: 0, lastError: null, step: null }
      ui.state.desktopRuntime = { status: 'ready', seatId: 'seat-9' }
      assert(ui.seatStage() === 'ready', `装好了还挡着：${ui.seatStage()}`)
      assert(ui.chatDeployPrompt('b9') === '', '装好了还画着安装屏')
    })

    await test('安装读秒：年龄在收到那一刻锚成本地时刻，往后不再跟服务端比', async () => {
      /**
       * 这一条钉的是两件事，都属于「读秒必须可信」：
       *
       * 1. **锚点算一次就不动。** 服务端给的是「已经装了多久」（不是起始时刻——两台钟差
       *    几分钟是常事，拿绝对时刻自己减本地时钟，一台快十分钟的电脑会在人刚按下
       *    「创建」的那一秒写出「已经装了 10:03」）。收到之后锚成本地时刻，之后每轮
       *    轮询都沿用它——每轮重锚的话，网络抖一下这个数就往回跳，而人正盯着它判断
       *    「是不是卡住了」。
       * 2. **上一轮没跑完就不开下一轮。** 收尾那一段（拉席位、拉名册、接会话）比两秒长
       *    是常事，叠进来的第二轮会把 ensureChatSession 排好的退避重试取消掉、紧接着
       *    自己再发一次——退避于是变成每两秒一记的硬打，而这条路要经管家转到席位机器上。
       */
      let hits = 0
      let ageMs = 200_000
      let gate = null
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: 'ui-smoke-token',
        fetchImpl: async (path) => {
          if (!path.startsWith('/runtime/deploy/progress')) throw new Error('这条用例只该问进度：' + path)
          hits += 1
          if (gate) await gate
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({ status: 'deploying', phase: 'installing', elapsedMs: ageMs, lastError: null, stale: false, step: null }),
          }
        },
      })
      ui.state.me = { account: { id: 'me', companyId: 'c1', role: 'member', email: 'm@x' }, company: { id: 'c1' } }
      ui.state.path = '/a/b9'
      ui.state.chatBotId = 'b9'
      ui.state.runtimeMachine = { paired: true }
      ui.state.runtimeBots = [{ id: 'b9', name: '新助手', runtime: { status: 'deploying' } }]

      await ui.pollDeployProgress()
      const first = ui.state.deployProgress
      assert(first && first.botId === 'b9', `没认下这份进度：${JSON.stringify(first)}`)
      assert(first.startedAt === undefined, '服务端不该再发绝对时刻，前端也不该留着它')
      const drift = Math.abs(Date.now() - ageMs - first.since)
      assert(drift < 5000, `锚点没按年龄算：差了 ${drift}ms`)

      // 第二轮：服务端那个数无论怎么变，锚点都不动——同一次安装的读秒只能往前走。
      ageMs = 1000
      await ui.pollDeployProgress()
      assert(ui.state.deployProgress.since === first.since, '每轮都重锚了，读秒会往回跳')

      // 那道闸：上一轮挂着的时候，第二次调用一个请求都不许发。
      const before = hits
      let open
      gate = new Promise((r) => (open = r))
      const running = ui.pollDeployProgress()
      const overlapped = ui.pollDeployProgress()
      assert(hits === before + 1, `叠进来又发了一次：${hits - before} 次`)
      open()
      gate = null
      await running
      await overlapped
      // 闸放开之后照旧能问下一轮，不能一次卡住就再也不转了。
      await ui.pollDeployProgress()
      assert(hits === before + 2, `闸没放开：${hits - before} 次`)
    })

    await test('按下停止：从按下到真停下来那一段，界面上必须有动静', async () => {
      /**
       * 这一条钉的是那次报障：点停止之后什么都不变——按钮还是那颗「停止」，输入框
       * 底下还写着「正在思考」。而停止本来就不是当场生效的（界面 → Gateway → 席位 →
       * `agent.abort()` → 手上那一步收尾 → `turn/end`），那一段里流上一个事件都不会来。
       * 于是「已经在停了」和「点了没反应」在屏幕上长得一模一样，人只好反复点。
       *
       * 按钮那圈转的验不到（垫片里没有 CSS），能钉住的是它下面这两件事：**请求还在
       * 路上时状态就已经变了**，以及那行小字这时候说的是什么。
       */
      let release = () => {}
      const gate = new Promise((r) => (release = r))
      const ui = loadApp({
        appPath,
        base: gwBase,
        fetchImpl: async (path, init) => {
          if (path.includes('/abort')) {
            await gate
            return { ok: true, status: 200, text: async () => JSON.stringify({ aborted: true }) }
          }
          return fetch(gwBase + path, init)
        },
      })
      await ui.boot()
      ui.state.chatSessionId = 's-stop'
      ui.state.chatStatus = 'thinking'

      const pending = ui.abortChat()
      await new Promise((r) => setTimeout(r, 0))
      // 请求还卡在 gate 上——**这一刻**就得有痕迹，等它回来才改就已经晚了。
      assert(ui.state.chatStopping === 's-stop', '按下去之后没有留下「已经收到」的痕迹')
      const tip = ui.composerTip(true)
      assert(tip.includes('正在停止'), `那行小字没改口：${tip}`)
      assert(tip.includes('Bot'), `没说清停止要下发到 Bot 才生效：${tip}`)
      assert(!tip.includes('正在思考'), `还写着「正在思考」——它已经在停了：${tip}`)

      release()
      await pending
      // 席位收下了不等于停住了。这时候收掉转圈就是撒谎——`turn/end` 还没回来。
      assert(ui.state.chatStopping === 's-stop', '请求一回来就把「正在停止」收了，可它还没停')

      // 停久了改口：多半是卡在一个正跑着的工具上，把原因说出来，别让人对着一句
      // 不动的「正在停止…」猜。
      ui.state.chatStoppingAt = Date.now() - 20000
      const slow = ui.composerTip(true)
      assert(slow.includes('收尾'), `停了 20 秒还没换说法：${slow}`)
      assert(/\d/.test(slow), `没有读秒，一行不动的字看着更像卡死了：${slow}`)

      // 换到别的会话就不该再显示它：这一格记的是「哪条会话在停」。
      ui.state.chatSessionId = 's-other'
      assert(ui.composerTip(true).includes('正在思考'), '别的会话上也挂着「正在停止」')
    })

    await test('停止没送到：转圈要收掉，按钮得还能再按一次', async () => {
      const ui = loadApp({
        appPath,
        base: gwBase,
        fetchImpl: async (path, init) => {
          if (path.includes('/abort')) return { ok: false, status: 502, text: async () => JSON.stringify({ error: '席位没应答' }) }
          return fetch(gwBase + path, init)
        },
      })
      await ui.boot()
      ui.state.chatSessionId = 's-fail'
      ui.state.chatStatus = 'thinking'
      await ui.abortChat()
      assert(ui.state.chatStopping === '', '这一下根本没送到，却留下一颗一直转的按钮')
      assert(String(ui.state.error || '').includes('没能中止'), `没说这一下白按了：${ui.state.error}`)
      assert(ui.composerTip(true).includes('正在思考'), '那行小字还停在「正在停止」上')
    })

    await test('空库 + 没有票 → 画「创建系统管理员」，不是登录页', async () => {
      const ui = await boot()
      const html = ui.html()
      assert(html.includes('创建系统管理员'), '没画初始化页')
      assert(!html.includes('登录 Satuwork'), '画成登录页了')
      assert(html.includes('id="setup-form"'), '缺创建表单')
    })

    await test('空库 + 手上有张废票 → 仍然画初始化页，且不显示「登录已过期」', async () => {
      // 这一条正是修之前的错法：有票就直奔 /me，失败后落回登录页——死胡同。
      const ui = await boot('eyJhbGciOiJSUzI1NiJ9.stale.token')
      const html = ui.html()
      assert(html.includes('创建系统管理员'), '废票把初始化页挡住了')
      assert(!html.includes('登录已过期'), '不该给出一条误导的过期提示')
      assert(ui.token() === undefined || !ui.token(), '废票应被清掉')
    })

    let ownerToken = ''
    await test('建完管理员后，同一份 app.js 画的是控制台不是登录页', async () => {
      const created = await req(gwBase, 'POST', '/auth/setup', {
        body: { email: 'owner@ui.test', name: '老板', password: 'correct-horse-1' },
      })
      assert(created.status === 201, `setup ${created.status} ${created.text}`)
      ownerToken = created.json.token

      const ui = await boot(ownerToken)
      const html = ui.html()
      assert(!html.includes('创建系统管理员'), '已经有管理员了还画初始化页')
      assert(!html.includes('id="login-form"'), '画成登录页了')
      assert(html.includes('owner@ui.test'), '侧栏没有当前账号')
    })

    await test('有管理员 + 没有票 + / → 画首页，不是登录页', async () => {
      // `/` 是给还没开通的人看的那一屏（见 gateway/ui/pages-landing.js）；登录挪去了
      // `/login`。这条守的是「首页别退回成登录表单」——那正是这次改动之前的样子。
      const ui = await boot()
      const html = ui.html()
      assert(html.includes('satu-lp-hero'), '没画首页')
      assert(!html.includes('id="login-form"'), '首页上画出了登录表单')
      assert(!html.includes('创建系统管理员'), '不该再出初始化页')
      // 顶栏那颗 GitHub。它是**真链接**而不是 data-act 按钮（中键、右键复制地址要能用），
      // 所以点击处理器那套测试一条都盖不到它——在这儿钉一下地址和开新标签页的规矩。
      const gh = html.match(/<a[^>]*satu-lp-ghlink[^>]*>/)
      assert(gh, '顶栏上没有 GitHub 那颗')
      assert(gh[0].includes('href="https://github.com/effortson/satuwork"'), 'GitHub 指错了地方：' + gh[0])
      assert(gh[0].includes('rel="noopener noreferrer"'), '开新标签页没带 noopener：' + gh[0])
    })

    await test('有管理员 + 没有票 + /login → 画登录页', async () => {
      const ui = await boot(undefined, { path: '/login' })
      const html = ui.html()
      assert(html.includes('登录 Satuwork'), '没画登录页')
      assert(html.includes('id="login-form"'), '登录表单不在')
      assert(!html.includes('satu-lp-hero'), '登录页上混进了首页')
    })

    await test('桌面壳里 / 直接是登录页', async () => {
      // 壳子是应用不是网站：开机第一件事是连回自己那台 Gateway，中间不插产品介绍。
      const ui = await boot(undefined, { path: '/', desktop: true })
      const html = ui.html()
      assert(html.includes('id="login-form"'), '桌面壳里没画登录页')
      assert(!html.includes('satu-lp-hero'), '桌面壳里画了首页')
    })

    await test('首页那块演示是真能点的：换个 AI 员工，右边整条对话跟着换', async () => {
      // 首屏右边不是一张图，是一块小演示（gateway/ui/pages-landing.js 的 lpShot）。
      // 它退化成图的方式很安静：名册还画得出来、点下去却没反应——那时页面看着一切正常。
      // 换人只重画 #satu-lp-demo 那一格（不走 render），所以这里把它桩起来看。
      const ui = await boot(undefined, { stubIds: ['satu-lp-demo'] })
      assert(ui.html().includes('data-act="landing-demo"'), '名册那几行不是按钮')
      await ui.fire('click', el('button', { 'data-act': 'landing-demo', 'data-i': '2' }))
      const pane = ui.stubs.get('satu-lp-demo')
      assert(pane.innerHTML.includes('已转人工'), '换人之后右边没跟着换：' + pane.innerHTML.slice(0, 120))
      assert(!pane.innerHTML.includes('退款单'), '上一个人的对话还留在右边')
      // 对话下沿那个输入框**是一颗去登录的按钮**，不是个能打字的框（见 lpComposer）。
      // 哪天它退化成一个死框，页面看着照样完整——所以这里钉住那条 href。
      const box = pane.innerHTML.match(/<button[^>]*satu-lp-composer[^>]*>/)
      assert(box, '对话底下那个输入框不见了')
      assert(box[0].includes('data-href="/login"'), '输入框点下去不去登录：' + box[0])
    })

    await test('首页顶栏的「联系销售」：二维码那张图真的取得到，链接和图对的是同一个号', async () => {
      const ui = await boot()
      assert(ui.html().includes('data-act="landing-sales"'), '顶栏没有「联系销售」')
      assert(!ui.html().includes('landing-sales-close'), '还没点就把弹窗画出来了')

      await ui.fire('click', el('button', { 'data-act': 'landing-sales' }))
      const html = ui.html()
      const img = html.match(/<img[^>]*sales-whatsapp\.svg[^>]*>/)
      assert(img, '弹窗里没有二维码')
      const link = html.match(/href="(https:\/\/wa\.me\/[0-9]+)"/)
      assert(link, '弹窗里没有 wa.me 链接')

      /**
       * **图是静态的，链接是常量拼的——两者会各改各的。** 改了号码却忘了重新生成
       * 二维码，页面上写着新号、扫出来还是旧的，而没人会去扫自己页面上的二维码。
       * 这里没法读出码里编的是什么（那要一个解码器），但能钉住另外两件事：
       *
       *   1. 那张图真的取得到（换号时新文件名写错、或者忘了提交，表现就是一个空白框）
       *   2. 弹窗上印的号码和链接里的是同一个
       */
      const asset = await req(gwBase, 'GET', '/assets/sales-whatsapp.svg')
      assert(asset.status === 200, `二维码取不到：${asset.status}`)
      assert(String(asset.headers.get('content-type')).startsWith('image/svg+xml'), `二维码的 content-type 是 ${asset.headers.get('content-type')}`)
      const digits = link[1].slice('https://wa.me/'.length)
      const shown = (html.match(/>([+0-9 ]{8,})</g) || []).map((x) => x.replace(/[^0-9]/g, ''))
      assert(shown.includes(digits), `弹窗上印的号码和 wa.me 链接对不上：链接 ${digits}，页面上是 ${JSON.stringify(shown)}`)

      await ui.fire('click', el('button', { 'data-act': 'landing-sales-close' }))
      assert(!ui.html().includes('landing-sales-close'), '关不掉')
    })

    await test('隐私政策和服务条款：没票、有票、桌面壳里都是同一份文本', async () => {
      /**
       * 这两页（gateway/ui/pages-legal.js）**不看登录状态**，理由见 render.js 里那段：
       * 真要看它们的人多半还没有账号。退化的方式很安静——路由挪一下，它们就落进
       * anonView，没票的人看到的是登录表单，而链接照样点得开、地址栏也是对的。
       */
      for (const opts of [{}, { desktop: true }]) {
        for (const path of ['/privacy', '/terms']) {
          const ui = await boot(undefined, { ...opts, path })
          const html = ui.html()
          const want = path === '/terms' ? '服务条款' : '隐私政策'
          assert(html.includes(`<h1>${want}</h1>`), `${path}${opts.desktop ? '（桌面壳）' : ''} 没画出${want}：` + html.slice(0, 160))
          assert(!html.includes('id="login-form"'), `${path} 被登录表单挡住了`)
          assert(!html.includes('satu-lp-hero'), `${path} 画成了首页`)
        }
      }
      // 有票的人也进得去。这一条钉的是 loadPage 里那道放行：不放的话 pathAllowed
      // 一律说不行，人会被弹回 `/`——表现是登录之后页脚上那两个链接点了没反应。
      const signed = await boot(ownerToken, { path: '/privacy' })
      assert(signed.html().includes('<h1>隐私政策</h1>'), '有票的人打不开隐私政策')
      assert(signed.state.path === '/privacy', '有票时被弹去了 ' + signed.state.path)
    })

    await test('隐私政策切成英文：正文跟着换，不是只换了标题', async () => {
      const ui = await boot(undefined, { path: '/privacy' })
      await ui.fire('click', el('button', { 'data-act': 'landing-locale', 'data-locale': 'en' }))
      const html = ui.html()
      assert(html.includes('Privacy Policy'), '标题没换成英文')
      assert(html.includes('What this policy covers'), '正文还是中文：' + html.slice(0, 200))
      assert(!html.includes('这份政策管什么'), '中英混在了一起')
    })

    await test('首页和登录页底下都找得到这两页', async () => {
      // 页脚是外面找它们的地方：法务、合规问卷、应用商店的上架表单都是先翻到最底下。
      const home = (await boot()).html()
      for (const href of ['/privacy', '/terms']) {
        assert(home.includes(`data-href="${href}"`), `首页页脚上没有 ${href}`)
      }
      // 登录那三屏上它们是**真链接、开新标签页**（见 shell.js 的 authAside）：底下那个
      // 表单填了一半，站内跳过去再回来，口令那两格是空的。
      const login = (await boot(undefined, { path: '/login' })).html()
      for (const href of ['/privacy', '/terms']) {
        const a = login.match(new RegExp(`<a[^>]*href="${href}"[^>]*>`))
        assert(a, `登录页上没有 ${href}`)
        assert(a[0].includes('target="_blank"'), `${href} 不是开新标签页，会把填了一半的表单冲掉：` + a[0])
        assert(a[0].includes('rel="noopener noreferrer"'), `${href} 开新标签页没带 noopener：` + a[0])
      }
    })

    await test('注册和接受邀请：提交按钮底下有「点了就等于同意」那句，两条都点得开', async () => {
      /**
       * 这句话的位置就是它的全部意义——挨着那颗按钮才说得清「你按下去这一下意味着
       * 什么」。它退化的方式很安静：页脚上那两条链接还在，于是页面看着「有条款」，
       * 而同意这件事从来没在按下去之前说出口。
       */
      const consent = (html, act) => {
        assert(html.includes('satu-authconsent'), `${act} 那屏没有这句话`)
        const line = html.slice(html.indexOf('satu-authconsent'))
        assert(line.includes(`点击「${act}」`), `这句话没指着那颗按钮：` + line.slice(0, 120))
        for (const href of ['/terms', '/privacy']) {
          const a = line.match(new RegExp(`<a[^>]*href="${href}"[^>]*>`))
          assert(a, `${act} 那句话里没有 ${href}`)
          assert(a[0].includes('target="_blank"'), `${act} 那句话里的 ${href} 会把填了一半的表单冲掉：` + a[0])
        }
        // 按钮在前、这句话在后：它说的是「点击上面那颗」。
        assert(html.indexOf('btn-primary btn-block') < html.indexOf('satu-authconsent'), `${act}：这句话跑到按钮上面去了`)
      }

      const setup = await boot()
      setup.state.me = null
      setup.state.needsSetup = true
      setup.render()
      consent(setup.html(), '创建并进入')

      const join = await boot()
      join.state.path = '/join/tok'
      join.state.joinInvite = { loading: false, valid: true, email: 'new@ui.test', name: '小新', expiresAt: 0, error: '' }
      join.state.joinForm = { name: '小新', password: '', confirm: '' }
      join.render()
      consent(join.html(), '加入 Satuwork')
    })

    await test('首页下载那一段：Windows 的浏览器进来摆 Windows 的包，Mac 的摆 Mac 的', async () => {
      /**
       * 这一段（gateway/ui/pages-landing.js 的 lpDownload）唯一的自动动作就是认系统，而它退化的
       * 方式最安静：页面照样完整、按钮照样能点，只是 Mac 上摆着一个 .exe——人下下来
       * 双击，什么都不会发生，也不会有人回来报这个 bug。
       */
      const win = await boot(undefined, { path: '/', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' })
      const winHtml = win.html()
      assert(winHtml.includes('-setup.exe'), 'Windows 上没摆出 .exe：' + winHtml.slice(0, 200))
      assert(!winHtml.includes('.dmg'), 'Windows 上摆出了 .dmg')

      const mac = await boot(undefined, { path: '/', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' })
      const macHtml = mac.html()
      // Intel Mac 的 UA 里也带着 `Mac OS X`，Apple 芯片的机器一样报这一串——两档都该
      // 摆出来，让人自己认（浏览器里认不出芯片，见 dlBuilds 上那段）。
      assert(macHtml.includes('_aarch64.dmg'), 'Mac 上没有 Apple 芯片那一档：' + macHtml.slice(0, 200))
      assert(macHtml.includes('_x64.dmg'), 'Mac 上没有 Intel 那一档')
      assert(!macHtml.includes('-setup.exe'), 'Mac 上摆出了 .exe')
    })

    await test('首页下载那一段：iPhone、iPad 不认成 Mac——那上面没有桌面端可装', async () => {
      // iPhone / iPad 的 UA 里都写着「like Mac OS X」；只看字样的话它们全被认成 Mac，页面还说
      // 「看起来你正用的就是这个系统」，把一个装不上的 .dmg 摆到人面前。
      const phones = [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
      ]
      for (const userAgent of phones) {
        const html = (await boot(undefined, { path: '/', userAgent })).html()
        assert(!html.includes('看起来你正用的就是这个系统'), `移动设备被认成了桌面系统：${userAgent}`)
        assert(html.includes('没认出你的系统'), `移动设备上该照实说没认出来：${userAgent}`)
      }
      // iPadOS 默认的桌面版网页模式：UA 和 Mac 一字不差，只有触点数露馅（Mac 没有触摸屏）。
      const desktopMode = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
      const ipad = (await boot(undefined, { path: '/', userAgent: desktopMode, maxTouchPoints: 5 })).html()
      assert(!ipad.includes('看起来你正用的就是这个系统'), '桌面版网页模式的 iPad 被认成了 Mac')
      const mac = (await boot(undefined, { path: '/', userAgent: desktopMode })).html()
      assert(mac.includes('看起来你正用的就是这个系统'), '真 Mac（没有触点）反而不认了')
    })

    await test('首页下载那一段：认不出系统也要有东西可下，而且能自己切', async () => {
      // 垫片默认那个 UA（satuwork-ui-smoke）两边都不像，走的正是「没认出来」那条路。
      const ui = await boot(undefined, { path: '/' })
      assert(ui.html().includes('-setup.exe'), '认不出系统时一个包都没摆出来')
      assert(ui.html().includes('没认出你的系统'), '没说明是没认出来，人会以为这就是他的系统')

      // 在 Mac 上替同事下 Windows 包是常事，反过来也是——自动只是默认值，不是唯一的路。
      await ui.fire('click', el('button', { 'data-act': 'download-os', 'data-os': 'mac' }))
      assert(ui.html().includes('_aarch64.dmg'), '切到 macOS 之后没换包：' + ui.html().slice(0, 200))
      assert(!ui.html().includes('-setup.exe'), '切过去了 Windows 的包还在')
      // 没签名的 Mac 包报的是「已损坏」，右键打开绕不过去——得给那行 xattr，和 Release 说明一致。
      assert(ui.html().includes('xattr -dr com.apple.quarantine /Applications/Satuwork.app'), 'Mac 那一档没给摘隔离标记的命令')
      assert(!ui.html().includes('右键选「打开」'), 'Mac 那一档还在教右键打开，那条路对「已损坏」不管用')
    })

    await test('下载地址指的是 desktop-latest，而且和发版 CI 传上去的名字对得上', async () => {
      /**
       * 这个仓库里几条发布线共用一个 Release 列表，GitHub 的 `releases/latest` 指的是**别条线
       * 上最新的那一个**——本地 Bot 发一版，下载那一段就跟着指到它的包上去，而页面上看不出
       * 任何毛病。所以地址钉在一个固定的 Release（desktop-latest）上，发版 CI 每次覆盖它。
       *
       * 两边是一对：页面上的文件名（pages-landing.js 的 dlBuilds）必须正是 CI 往 desktop-latest
       * 传的那几个（desktop-release.yml 的「同步到 desktop-latest」）。改了一边忘了另一边，
       * 按钮全是 404，而 CI 和页面都看不出错。
       */
      const workflow = readFileSync(join(root, '.github/workflows/desktop-release.yml'), 'utf8')
      const hrefs = []
      for (const os of ['windows', 'mac']) {
        const ui = await boot(undefined, { path: '/' })
        await ui.fire('click', el('button', { 'data-act': 'download-os', 'data-os': os }))
        hrefs.push(...[...ui.html().matchAll(/<a[^>]*href="([^"]+)"[^>]*\bdownload\b/g)].map((m) => m[1]))
      }
      assert(hrefs.length === 3, '该是三档包（Windows 一档、Mac 两档）：' + hrefs.join(' '))
      for (const href of hrefs) {
        assert(href.startsWith('https://github.com/effortson/satuwork/releases/download/desktop-latest/'), '下载地址不对：' + href)
        assert(!href.includes('/releases/latest/'), 'latest 会指到别条发布线的包上：' + href)
        const file = href.split('/').pop()
        assert(!/\d+\.\d+\.\d+/.test(file), '文件名里带着版本号，发了新版就 404：' + file)
        assert(workflow.includes(`latest/${file}`), `发版 CI 没往 desktop-latest 传 ${file}`)
      }
      const html = (await boot(undefined, { path: '/' })).html()
      // **是 `<a download>` 不是 data-act 按钮**：右键「链接存储为」、复制地址这些要能用，
      // 而这一段恰恰有人要把地址复制给别人。
      assert(!html.includes('data-act="download-get"'), '下载做成了按钮，右键复制地址就没了')
    })

    await test('老的 /download 地址折到首页下载那一段', async () => {
      // 那一页已经并进首页（pages-landing.js 的 lpDownload），可这条地址早被管理员发出去过。
      // 折回来的样子：地址换成 /#download，画的是首页，第一次画完滚到那一段（render.js）。
      const ui = await boot(undefined, { path: '/download' })
      const html = ui.html()
      assert(ui.state.path === '/', '老地址没折回首页：' + ui.state.path)
      assert(ui.location.pathname !== '/download', '地址栏还停在 /download')
      assert(html.includes('id="download"'), '折回首页了，却没有下载那一段：' + html.slice(0, 160))
      assert(html.includes('satu-lp-hero'), '画的不是首页')
      assert(!ui.state.lpJump, '跳转那一下画完了还挂着，登出再回首页会被莫名拽到页底')
    })

    await test('首页下载那一段切成英文：正文跟着换', async () => {
      const ui = await boot(undefined, { path: '/' })
      await ui.fire('click', el('button', { 'data-act': 'landing-locale', 'data-locale': 'en' }))
      const html = ui.html()
      assert(html.includes('Download Satuwork for desktop'), '标题没换成英文')
      assert(!html.includes('下载 Satuwork 桌面端'), '中英混在了一起')
    })

    await test('下载那一段接在「怎么开始」后面，首页和登录页都找得到它', async () => {
      const home = (await boot()).html()
      const band = home.indexOf('satu-lp-band')
      const dl = home.indexOf('id="download"')
      assert(band > 0 && dl > band, '下载那一段没接在「怎么开始」后面')
      assert(dl < home.indexOf('satu-lp-foot'), '下载那一段跑到页脚后面去了')
      /**
       * **首屏上也要有一条路**：那一段在页面最底下，首屏一个字都不提的话没人知道有这东西。
       * 首屏 CTA 底下那行小字和页脚各一条，都是滚到那一段，不再跳去别的页。
       */
      assert(home.includes('satu-lp-finelink" data-act="landing-download"'), '首屏那行小字里没指到下载那一段')
      assert((home.match(/data-act="landing-download"/g) || []).length >= 2, '页脚上没有指到下载那一段')
      assert(!home.includes('data-href="/download"'), '首页上还有指向老下载页的站内跳转')
      // 登录那三屏上是**真链接、开新标签页**（见 shell.js 的 authAside）：底下那个表单
      // 填了一半，站内跳过去再回来，口令那两格是空的。
      const login = (await boot(undefined, { path: '/login' })).html()
      const a = login.match(/<a[^>]*href="\/#download"[^>]*>/)
      assert(a, '登录页上没有下载桌面端')
      assert(a[0].includes('target="_blank"'), '下载桌面端不是开新标签页，会把填了一半的表单冲掉：' + a[0])
      assert(a[0].includes('rel="noopener noreferrer"'), '下载桌面端开新标签页没带 noopener：' + a[0])
      // 桌面壳里不给：人已经在桌面端里了，而且壳里的 `/` 就是登录，没有首页可指。
      const shell = (await boot(undefined, { path: '/login', desktop: true })).html()
      assert(!shell.includes('#download'), '桌面壳的登录页上还挂着下载桌面端')
    })

    await test('这三个地址刷新和法律页那个分片都由 Gateway 交得出来', async () => {
      // 分片漏进 http.ts 的 UI_PARTS 是条安静的路：本地开 index.html 一切正常，
      // 线上那个文件 404，两页连同整串脚本一起死在浏览器里。/download 已经不是一页了，
      // 但地址还得交得出 index.html——发出去的老链接靠它折回首页。
      for (const path of ['/privacy', '/terms', '/download']) {
        const page = await req(gwBase, 'GET', path, { headers: { accept: 'text/html' } })
        assert(page.status === 200, `刷新 ${path} → ${page.status}`)
        assert(page.text.includes('data-app-part'), `刷新 ${path} 拿到的不是 index.html`)
      }
      for (const file of ['/pages-legal.js']) {
        const part = await req(gwBase, 'GET', file)
        assert(part.status === 200, `${file} → ${part.status}`)
        assert(String(part.headers.get('content-type')).includes('javascript'), `${file} 的 content-type 是 ${part.headers.get('content-type')}`)
      }
    })

    await test('首页上点「登录」进得了登录页', async () => {
      const ui = await boot()
      await ui.fire('click', el('button', { 'data-act': 'go', 'data-href': '/login' }))
      assert(ui.location.pathname === '/login', '地址没变成 /login：' + ui.location.pathname)
      assert(ui.html().includes('id="login-form"'), '没画成登录页')
    })

    await test('审计正文渲染：消息要出来，不能是「（空）」', async () => {
      const ui = await boot(ownerToken)
      const html = ui.auditTranscript([
        { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'UI-SMOKE-员工说的' }] } } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'UI-SMOKE-助理答的' }] } } },
        { type: 'tool/call', data: { name: 'clock' } },
      ])
      assert(html.includes('UI-SMOKE-员工说的'), '员工消息没渲染出来')
      assert(html.includes('UI-SMOKE-助理答的'), '助理消息没渲染出来')
      assert(!html.includes('（空）'), '渲染成了「（空）」')
      assert(html.includes('工具 clock'), '工具调用没渲染')
    })

    await test('模型页「测试连通性」：跑完一轮，busy 和结果都画得出来', async () => {
      // 修之前 testMark 里的局部变量把文案函数 t 遮住了，一进 busy 这一帧就抛
      // 「t is not a function」，按钮点下去什么都不会发生——接口是好的，e2e 拦不住。
      const ui = await boot(ownerToken)
      ui.state.path = '/models'
      await ui.saveSettings({ daily: { provider: 'e2e-fake', model: 'probe-me' } })

      ui.state.tests['role:daily'] = { status: 'busy' }
      ui.render()
      assert(ui.html().includes('测试中…'), 'busy 这一帧没画出来')

      delete ui.state.tests['role:daily']
      await ui.testLlm('role', { role: 'daily' })
      const res = ui.state.tests['role:daily']
      assert(res, '测完没留下结论')
      assert(res.status !== 'busy', `还停在 busy：${JSON.stringify(res)}`)
      // 上游是假的，只可能是 err；要的是「有结论且画得出来」，不是「通了」。
      assert(res.status === 'err', `预期 err，拿到 ${res.status}`)
      assert(ui.html().includes(res.text.slice(0, 8)), '结论没画到页面上')
    })

    await test('供应商页「测试」：没配密钥时给出结论，不是静默', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/providers'
      await ui.testLlm('provider', { provider: 'e2e-fake' })
      const res = ui.state.tests['provider:e2e-fake']
      assert(res && res.status === 'err', `预期 err，拿到 ${JSON.stringify(res)}`)
      assert(res.text && res.text.length > 0, '错误文案是空的')
    })

    await test('换了模型就丢掉上一次的连通性结论', async () => {
      const ui = await boot(ownerToken)
      ui.state.tests['role:daily'] = { status: 'ok', text: '通了 12ms · a/b' }
      await ui.saveSettings({ daily: { provider: 'e2e-fake', model: 'another-model' } })
      assert(!ui.state.tests['role:daily'], '换了模型还留着上一次的绿字')
    })

    await test('单价倍率：存得下、画得出、倍率单价按倍数算', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/models'
      ui.state.selectedProvider = 'e2e-prov'
      ui.state.catalog = [
        {
          provider: 'e2e-prov',
          name: 'E2E',
          models: [
            { id: 'priced', name: 'Priced', cost: { input: 2, output: 8 } },
            { id: 'unpriced', name: 'Unpriced', cost: { input: 0, output: 0 } },
          ],
        },
      ]

      // 走真的 change 派发，不是直接调函数——这个分支最早就接错了位置：
      // 挂在「只收 select」那道关卡后面，函数本身是好的，改了框子什么也不会发生。
      await ui.fire('change', el('input', { 'data-act': 'price-multiplier' }, '1.5'))
      assert(ui.state.settings.priceMultiplier === 1.5, `没存下：${ui.state.settings.priceMultiplier}`)

      // 存完要真的回到库里，不是只留在内存。
      const back = await ui.api('GET', '/platform/settings')
      assert(back.priceMultiplier === 1.5, `库里是 ${back.priceMultiplier}`)

      ui.render()
      const html = ui.html()
      assert(html.includes('倍率单价 ×1.5'), '表头没有倍率列')
      assert(html.includes('$2.00 / $8.00'), `原价没画出来：${html.includes('$2.00')}`)
      assert(html.includes('$3.00 / $12.00'), '倍率单价算错或没画出来')
      // 目录里没有价的模型不能显示成 $0.000——那会被读成免费。
      assert(!html.includes('$0.000'), '没有价的模型画成了 $0.000')
    })

    await test('兜底单价：存得下、按它给没有价的模型报价、画成估数的样子', async () => {
      /**
       * 没有兜底时，目录里查不到价的模型收的是 $0——账单上的 $0 和「免费」长得一模一样，
       * 那一截钱月底就少了。兜底把这批模型接住（docs/billing.md §3.3 的第 3 层）。
       *
       * 两件事一起钉：**兜底压在目录价下面**（有价的模型一分钱不变），以及**兜底价要画得
       * 出是估数**——看不出是估数的话，一个离谱的价会一直收下去，没人会去查。
       */
      const ui = await boot(ownerToken)
      ui.state.path = '/models'
      ui.state.selectedProvider = 'e2e-prov'
      ui.state.catalog = [
        {
          provider: 'e2e-prov',
          name: 'E2E',
          models: [
            { id: 'priced', name: 'Priced', cost: { input: 2, output: 8 } },
            { id: 'unpriced', name: 'Unpriced', cost: { input: 0, output: 0 } },
          ],
        },
      ]
      await ui.fire('change', el('input', { 'data-act': 'price-multiplier' }, '2'))
      ui.render()
      assert(ui.html().includes('兜底单价 / 1M tok'), '「单价倍率」那一块里没有兜底单价')

      // 走真的 change 派发：这个分支和倍率一样得排在「只收 select」那道关卡前面。
      const setDefault = (field, v) => ui.fire('change', el('input', { 'data-act': 'default-rate', 'data-field': field }, v))
      await setDefault('input', '5')
      await setDefault('output', '9')
      assert(ui.state.settings.defaultModelRate?.input === 5, `没存下：${JSON.stringify(ui.state.settings.defaultModelRate)}`)
      // 存完要真的回到库里，不是只留在内存。
      const back = await ui.api('GET', '/platform/settings')
      assert(back.defaultModelRate?.input === 5 && back.defaultModelRate?.output === 9, `库里是 ${JSON.stringify(back.defaultModelRate)}`)

      ui.render()
      let html = ui.html()
      /**
       * 没有价的那个模型现在报的是兜底价（原价 $5/$9，×2 之后 $10/$18），不再是「—」。
       * **两个数各自包在自己的 span 里**——兜底是逐项回落的，哪一项兜的就标哪一项，
       * 所以这里不能按 `$5.00 / $9.00` 那样连写去找。
       */
      for (const n of ['$5.00', '$9.00', '$10.00', '$18.00']) {
        assert(html.includes(n), `兜底价没报出 ${n}`)
      }
      // 兜底压在目录价下面：有价的那个模型一分钱都不该变。
      assert(html.includes('$2.00 / $8.00') && html.includes('$4.00 / $16.00'), '有目录价的模型被兜底改了价')
      // 兜底价要看得出是估数，不然一个离谱的价会一直收下去。
      assert(html.includes('按「单价倍率」里的兜底价收'), '兜底价没画成估数的样子')
      assert(!html.includes('$0.000'), '还有模型画成了 $0.000')

      /**
       * **逐项回落也要标出来。** 只填了 input 的模型，output 是兜底给的——整行判
       * （「两项都没有才算兜底」）的话这一行会画成普通实线，于是一个纯属拍脑袋的 output
       * 单价看上去和目录价一模一样，而唯一能挡住它的是有人看见。
       */
      ui.state.catalog = [
        { provider: 'e2e-prov', name: 'E2E', models: [{ id: 'half', name: 'Half', cost: { input: 3, output: 0 } }] },
      ]
      ui.render()
      html = ui.html()
      const at = html.indexOf('$6.00')
      assert(at > 0, '只填了 input 的那颗没按 ×2 报出 $6.00')
      assert(html.includes('$18.00'), 'output 没落到兜底价上')
      // input 是目录价（不标），output 是兜底给的（要标）。整行判的话这一段里一个都没有。
      assert(html.slice(at, at + 400).includes('按「单价倍率」里的兜底价收'), '逐项回落的 output 没画成估数')

      // 换回上面那两颗再验撤销：`half` 的 output 是 0，撤掉兜底之后它会画成 $0.000，
      // 那是「目录里 output 填了 0」这个由来已久的画法，和这条用例要验的东西没关系。
      ui.state.catalog = [
        {
          provider: 'e2e-prov',
          name: 'E2E',
          models: [
            { id: 'priced', name: 'Priced', cost: { input: 2, output: 8 } },
            { id: 'unpriced', name: 'Unpriced', cost: { input: 0, output: 0 } },
          ],
        },
      ]

      // 四项清空 = 撤掉兜底，回到「—」。这个开关得撤得掉。
      await setDefault('input', '')
      await setDefault('output', '')
      assert(!ui.state.settings.defaultModelRate?.input && !ui.state.settings.defaultModelRate?.output, `没撤掉：${JSON.stringify(ui.state.settings.defaultModelRate)}`)
      ui.render()
      html = ui.html()
      assert(!html.includes('$5.00') && !html.includes('$9.00'), '撤掉兜底之后还按它报价')
      assert(!html.includes('按「单价倍率」里的兜底价收'), '撤掉兜底之后还挂着兜底的悬浮说明')
      assert(!html.includes('$0.000'), '撤掉兜底之后画成了 $0.000')
    })

    await test('工具配置页：后端、密钥框、单价都画得出来，改动走真的派发', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/tools'
      await ui.loadWebTools()
      ui.render()
      let html = ui.html()
      assert(html.includes('网页与搜索'), '没画那个 tab')
      assert(html.includes('搜索后端') && html.includes('提取后端'), '两个下拉缺一个')
      // 只会搜索的后端不能出现在提取那个下拉里——配得出来的组合必须是能跑的。
      // 只截那个 select，不能截「提取后端」往后的整段：单价表里每个后端都要有一行。
      const at = html.indexOf('data-cap="extract"')
      assert(at > 0, '没找到提取后端的下拉')
      const extractSelect = html.slice(at, html.indexOf('</select>', at))
      assert(!extractSelect.includes('>DuckDuckGo<'), `提取下拉里列了只会搜索的后端：${extractSelect}`)
      assert(extractSelect.includes('>Tavily<'), '提取下拉里没有能提取的后端')

      // 走真的 change 派发，不是直接调函数：这个分支要排在「只收 select」那道关卡
      // 前面，接错了位置的话函数是好的、点了没反应（倍率输入框就栽过这一次）。
      await ui.fire('change', el('select', { 'data-act': 'web-backend', 'data-cap': 'search' }, 'duckduckgo'))
      assert(ui.state.webTools.web.searchBackend === 'duckduckgo', `没存下：${JSON.stringify(ui.state.webTools.web)}`)
      const back = await ui.api('GET', '/platform/tools/web')
      assert(back.web.searchBackend === 'duckduckgo', `库里是 ${back.web.searchBackend}`)
      ui.render()
      html = ui.html()
      assert(html.includes('封 IP'), 'DuckDuckGo 那句「无保障」的提醒没画出来')

      // 单价：界面按美元填，库里按整数「厘」存。
      await ui.fire('change', el('input', { 'data-act': 'web-price', 'data-backend': 'tavily', 'data-kind': 'search' }, '0.008'))
      assert(ui.state.webTools.web.pricing.tavily.search === 8, `单价没按厘存：${JSON.stringify(ui.state.webTools.web.pricing)}`)
      const back2 = await ui.api('GET', '/platform/tools/web')
      assert(back2.web.pricing.tavily.search === 8, `库里单价是 ${JSON.stringify(back2.web.pricing)}`)
    })

    await test('工具配置页：非 owner 进不去这条路径', async () => {
      const ui = await boot(ownerToken)
      // pathAllowed 是侧栏和路由共用的那道门。公司管理员不该有工具配置。
      ui.state.me = { account: { role: 'admin' }, company: { id: 'c1' } }
      assert(ui.pathAllowed('/tools') === false, '公司管理员被放进了工具配置')
      ui.state.me = { account: { role: 'owner' } }
      assert(ui.pathAllowed('/tools') === true, 'owner 反倒进不去')
    })

    await test('角色面板选了供应商，下面那张表跟着换', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/models'
      ui.state.catalog = [
        { provider: 'aa', name: 'AA', models: [{ id: 'aa-1', name: 'AA One' }] },
        { provider: 'bb', name: 'BB', models: [{ id: 'bb-1', name: 'BB One' }] },
      ]
      ui.state.selectedProvider = 'aa'
      await ui.fire('change', el('select', { 'data-act': 'role-provider', 'data-role': 'daily' }, 'bb'))
      assert(ui.state.selectedProvider === 'bb', `selectedProvider 还是 ${ui.state.selectedProvider}`)
      assert(ui.html().includes('BB One'), '表还停在上一个供应商')
    })

    await test('日常与 Utility 模型都能设置推理强度', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/models'
      ui.state.catalog = [{
        provider: 'e2e-fake',
        name: 'E2E',
        models: [{ id: 'reasoner', name: 'Reasoner', reasoning: true, reasoningLevels: ['off', 'low', 'medium', 'high'] }],
      }]
      await ui.saveSettings({
        daily: { provider: 'e2e-fake', model: 'reasoner', reasoningEffort: 'low' },
        utility: { provider: 'e2e-fake', model: 'reasoner', reasoningEffort: 'medium' },
      })
      ui.render()
      const html = ui.html()
      assert((html.match(/data-act="role-reasoning"/g) || []).length === 2, '两个角色没有各自的推理强度下拉')
      assert(html.includes('推理强度'), '没有推理强度标签')

      await ui.fire('change', el('select', { 'data-act': 'role-reasoning', 'data-role': 'daily' }, 'high'))
      assert(ui.state.settings.daily.reasoningEffort === 'high', `日常档位没存下：${JSON.stringify(ui.state.settings.daily)}`)
      assert(ui.state.settings.utility.reasoningEffort === 'medium', '改日常时误改了 Utility')
      const back = await ui.api('GET', '/platform/settings')
      assert(back.daily.reasoningEffort === 'high' && back.utility.reasoningEffort === 'medium', `库里档位不对：${JSON.stringify(back)}`)
    })

    await test('倍率越界：不落库，输入退回上一个有效值', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/models'
      const set = (v) => ui.fire('change', el('input', { 'data-act': 'price-multiplier' }, v))
      await set('2')
      await set('0')
      assert(ui.state.settings.priceMultiplier === 2, `0 倍被存下了：${ui.state.settings.priceMultiplier}`)
      await set('abc')
      assert(ui.state.settings.priceMultiplier === 2, '非数字被存下了')
      const back = await ui.api('GET', '/platform/settings')
      assert(back.priceMultiplier === 2, `库里被写坏了：${back.priceMultiplier}`)
    })

    await test('服务端也挡越界倍率，不只靠前端', async () => {
      const bad = await req(gwBase, 'PUT', '/platform/settings', {
        token: ownerToken,
        body: { priceMultiplier: 0 },
      })
      assert(bad.status === 400, `0 倍拿到 ${bad.status}`)
      const huge = await req(gwBase, 'PUT', '/platform/settings', {
        token: ownerToken,
        body: { priceMultiplier: 1e9 },
      })
      assert(huge.status === 400, `1e9 拿到 ${huge.status}`)
    })

    await test('自定义供应商：建出来就在列表里，缺密钥也在', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/providers'
      ui.state.providerDraft = { editing: false, id: 'my-llm', name: 'My LLM', baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', error: '' }
      await ui.saveCustomProvider()
      assert(!ui.state.providerDraft, `没保存成功：${JSON.stringify(ui.state.providerDraft)}`)
      const html = ui.html()
      assert(html.includes('My LLM'), '列表里没有这个自定义供应商')
      assert(html.includes('自定义'), '没标出「自定义」')
      // 还没配密钥也得列出来——不然没有地方能给它贴密钥。
      assert(html.includes('缺密钥'), '缺密钥的状态没画出来')
    })

    await test('给自定义供应商加模型，行上的计数跟着走', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/providers'
      await ui.loadCustomProviders()
      ui.state.modelsFor = 'my-llm'
      ui.state.modelDraft = { id: 'm1', name: 'M One', contextWindow: 65536, maxTokens: 4096, costInput: 1.5, costOutput: 3, reasoning: true, image: false }
      await ui.saveCustomModel()
      assert(!ui.state.providerError, `加模型报错：${ui.state.providerError}`)
      const p = (ui.state.customProviders || []).find((x) => x.id === 'my-llm')
      assert(p && p.models.length === 1, `模型没加上：${JSON.stringify(p && p.models)}`)
      assert(p.models[0].cost.input === 1.5, '单价没存下')
      assert(p.models[0].reasoning === true, '推理标记没存下')
      assert(ui.html().includes('模型 1'), '行上的模型计数没更新')
    })

    await test('自定义模型能打开原值并编辑，不会追加出重复模型', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/providers'
      await ui.loadCustomProviders()
      ui.state.modelsFor = 'my-llm'
      await ui.fire('click', el('button', { 'data-act': 'prov-model-edit', 'data-model': 'm1' }))
      const d = ui.state.modelDraft
      assert(d?.editing && d.originalId === 'm1', `没进入编辑态：${JSON.stringify(d)}`)
      assert(d.name === 'M One' && d.contextWindow === 65536 && d.costInput === 1.5, `原值没带进表单：${JSON.stringify(d)}`)
      assert(d.reasoning === true && d.image === false, '模型能力没有还原到表单')
      const editHtml = ui.html()
      assert(editHtml.includes('编辑模型'), '编辑表单没有明确标题')
      assert(/data-field="id"[^>]*disabled/.test(editHtml), '编辑时模型 id 仍然能改，会弄丢已有引用')

      Object.assign(d, {
        name: 'M One Updated',
        contextWindow: 131072,
        maxTokens: 8192,
        costInput: 2,
        costOutput: 4,
        costCacheRead: 0.2,
        costCacheWrite: 2.5,
        reasoning: false,
        image: true,
      })
      await ui.saveCustomModel()
      assert(!ui.state.providerError, `编辑模型报错：${ui.state.providerError}`)
      const p = (ui.state.customProviders || []).find((x) => x.id === 'my-llm')
      assert(p?.models?.length === 1, `编辑变成了追加：${JSON.stringify(p?.models)}`)
      const m = p.models[0]
      assert(m.id === 'm1' && m.name === 'M One Updated', `模型身份或名称错了：${JSON.stringify(m)}`)
      assert(m.contextWindow === 131072 && m.maxTokens === 8192, '窗口没有更新')
      assert(m.cost.input === 2 && m.cost.output === 4 && m.cost.cacheRead === 0.2 && m.cost.cacheWrite === 2.5, '价格没有更新')
      assert(m.reasoning === false && m.input.includes('image'), '模型能力没有更新')
    })

    await test('删自定义供应商：确认框画得出来，确认后真的删掉', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/providers'
      await ui.loadCustomProviders()
      // 确认框以前只在三个页面各画一份，供应商页没有——点了删除什么都不会弹。
      await ui.fire('click', el('button', { 'data-act': 'prov-delete', 'data-provider': 'my-llm', 'data-custom': '1' }))
      assert(ui.state.confirm?.kind === 'delete-custom-provider', `没进确认：${JSON.stringify(ui.state.confirm)}`)
      assert(ui.html().includes('删除自定义供应商'), '确认框没画出来')
      await ui.runConfirm()
      assert(!(ui.state.customProviders || []).some((x) => x.id === 'my-llm'), '没删掉')
    })

    await test('内置供应商的删除走的是「移除密钥」，不是删供应商', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/providers'
      await ui.fire('click', el('button', { 'data-act': 'prov-delete', 'data-provider': 'openai', 'data-custom': '' }))
      assert(ui.state.confirm?.kind === 'delete-credential', `走错分支：${JSON.stringify(ui.state.confirm)}`)
    })

    await test('统计窗口按本地时区算：今日 / 近 7 天 / 指定月', async () => {
      const ui = await boot(ownerToken)
      const dayStart = (ms) => {
        const d = new Date(ms)
        return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
      }

      ui.state.statsRange = 'today'
      const today = ui.statsWindow()
      assert(today.from === dayStart(Date.now()), '今日没有从本地零点开始')
      assert(today.to >= today.from, '今日窗口反了')

      ui.state.statsRange = '7d'
      const seven = ui.statsWindow()
      // 含今天，所以往回退 6 天，不是 7 天。
      assert(seven.from === dayStart(Date.now()) - 6 * 86400000, `近 7 天起点错了：${new Date(seven.from).toISOString()}`)

      ui.state.statsRange = 'month'
      ui.state.statsMonth = '2026-02'
      const feb = ui.statsWindow()
      assert(feb.from === new Date(2026, 1, 1).getTime(), '月起点错了')
      // 2026 年不是闰年，2 月 28 天——月末是算出来的，不是写死 30/31。
      assert(feb.to === new Date(2026, 2, 1).getTime() - 1, `月末错了：${new Date(feb.to).toString()}`)

      ui.state.statsMonth = '2024-02'
      const leap = ui.statsWindow()
      assert(new Date(leap.to).getDate() === 29, `闰年 2 月没算到 29 号：${new Date(leap.to).toString()}`)
    })

    await test('统计页：拉得到数、画得出表、没单价的模型有提示', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/stats'
      ui.state.statsRange = 'month'
      ui.state.statsMonth = new Date().toISOString().slice(0, 7)
      await ui.loadStats()
      assert(ui.state.stats, '没拉到统计数据')
      const html = ui.html()
      assert(html.includes('按公司'), '没画「按公司」')
      assert(html.includes('按模型'), '没画「按模型」')
      assert(html.includes('原价') && html.includes('已扣'), '两个金额列没都画出来')
      // 计费明细跟统计画在同一屏：汇总回答「多少」，明细回答「为什么是这个数」。
      assert(html.includes('计费明细'), '没画计费明细')
    })

    await test('明细和汇总永远问同一个时间窗', async () => {
      /**
       * 统计屏上那三颗胶囊只刷过汇总，底下的计费明细还留着上一个窗口的行——同一屏
       * 两张表各说各的时间段，人只会以为数字算错了。这条钉的是「窗口只有一个来源」。
       *
       * 只比到「几乎同时」，不比毫秒：`7d`/今天/用量那几档的边界是**此刻**，每次调用
       * 现取，前后两次天然差几毫秒。拿 === 比的话这条会随机红，红的还是时钟不是窗口
       * 来源。真走岔了算法差的是小时和天，这个容差照样拦得住。
       */
      const NEAR_MS = 2000
      const sameWindow = (a, b, what) => {
        assert(a && b, `${what}：窗口是空的`)
        assert(Math.abs(a.from - b.from) < NEAR_MS, `${what}：起点差了 ${a.from - b.from}ms`)
        assert(Math.abs(a.to - b.to) < NEAR_MS, `${what}：终点差了 ${a.to - b.to}ms`)
      }

      const ui = await boot(ownerToken)
      ui.state.path = '/stats'
      ui.state.statsRange = '7d'
      sameWindow(ui.chargesWindow('platform'), ui.statsWindow(), '统计屏的明细没跟着统计窗口')
      ui.state.statsRange = 'month'
      ui.state.statsMonth = '2026-02'
      const feb = ui.chargesWindow('platform')
      assert(feb.from === new Date(2026, 1, 1).getTime(), `换月之后明细没跟上：${new Date(feb.from).toString()}`)

      // 用量屏跟的是它自己那排胶囊，不是统计的。
      ui.state.path = '/usage'
      ui.state.usageRange = '近 7 天'
      sameWindow(ui.chargesWindow('org'), ui.usageRangeMs('近 7 天'), '用量屏的明细没跟着范围胶囊')

      // 账单页和平台的公司详情没有范围控件，那里就是全时段。
      ui.state.path = '/billing'
      assert(ui.chargesWindow('org') === null, '账单页凭空造了一个时间窗')
    })

    await test('计费明细：倍率对所有种类都画出来，不只是模型', async () => {
      // 这一列的全部意义是让人自己乘一遍对得上金额。倍率只加在模型那一支的时候，
      // 网页那行写着「4 条 × $0.0080」而金额是 $0.0384，对账的人会先怀疑金额错了。
      const ui = await boot(ownerToken)
      ui.state.path = '/billing'
      ui.state.billingTab = 'usage'
      ui.state.charges = {
        charges: [
          {
            id: 'c1', createdAt: Date.now(), companyId: 'o1', companyName: 'Acme', accountId: 'a1', accountName: '张三',
            kind: 'web', subject: 'tavily:extract', status: 'ok',
            quantity: { units: 4 }, unitPrice: { unit: 8000 }, multiplier: 1.2,
            amountMicros: 38400, amount: 0.0384, bonusMicros: 0, topupMicros: 38400, unpriced: false,
          },
        ],
        limit: 20, hasMore: false, nextCursor: null,
      }
      ui.render()
      const html = ui.html()
      assert(html.includes('4 条 × $0.0080'), `计量那格没画出来：${html.slice(0, 200)}`)
      assert(html.includes('倍率 ×1.2'), '网页那一行漏了倍率')
      assert(!html.includes('1.2000000476837158'), '倍率的小数位没收干净')

      /**
       * 同一张表，公司那边只画消耗。单价和倍率是平台怎么定价的，摊在客户面前
       * 等于把成本价一起交出去了；「扣了多少」照画——那是真花掉的钱。
       */
      ui.state.me = { account: { role: 'admin', email: 'a@x' }, company: { id: 'o1' }, settings: ui.state.settings }
      ui.render()
      const orgHtml = ui.html()
      assert(orgHtml.includes('4 条'), '公司侧连消耗都没画')
      assert(!orgHtml.includes('× $0.0080'), '公司侧把单价画出来了')
      assert(!orgHtml.includes('倍率'), '公司侧把倍率画出来了')
      assert(orgHtml.includes('$0.038'), '公司侧不该连金额一起藏掉')
    })

    await test('catalogBase：owner 走 /platform，公司管理员走 /orgs/:id', async () => {
      const ui = await boot(ownerToken)
      assert(ui.catalogBase() === '/platform', `owner 拿到 ${ui.catalogBase()}`)
      // 装成公司管理员：同一套页面，只有前缀不同。
      ui.state.me = { account: { role: 'admin', email: 'a@x' }, company: { id: 'org-1' }, settings: ui.state.settings }
      assert(ui.catalogBase() === '/orgs/org-1', `admin 拿到 ${ui.catalogBase()}`)
      // 成员没有公司目录可管，返回空串，调用方据此不发请求。
      ui.state.me = { account: { role: 'member', email: 'm@x' }, company: null }
      assert(ui.catalogBase() === '', `member 拿到 ${ui.catalogBase()}`)
    })

    await test('/bots 两副面孔：owner 是全局名录，公司管理员是那份模版', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/bots'
      ui.state.bots = [
        { id: 'g1', name: '全局助理', origin: 'global', scope: 'global', enabled: true },
        { id: 'c1', name: '老公司助理', origin: 'company', scope: 'company', enabled: false, legacy: true },
      ]
      // owner 管的就是全局那份，不该被标成只读。
      assert(ui.readOnlyItem(ui.state.bots[0]) === false, 'owner 被当成只读了')
      ui.render()
      assert(ui.html().includes('全局 Bot'), 'owner 侧标题不对')
      assert(ui.html().includes('配置'), 'owner 侧的行不该是只读')

      // 公司侧：这一页现在是模版。全局项和停用掉的老公司 Bot 列在底下，都只能看。
      ui.state.me = { account: { role: 'admin', email: 'a@x' }, company: { id: 'org-1' }, settings: ui.state.settings }
      assert(ui.readOnlyItem(ui.state.bots[0]) === true, '公司侧没把全局项当只读')
      assert(ui.readOnlyItem(ui.state.bots[1]) === true, '停用掉的老公司 Bot 该是只读')
      assert(ui.readOnlyItem({ id: 'u1', scope: 'user', origin: 'company' }) === false, '自己建的 Bot 被当成只读了')
      ui.state.template = { version: 3, prompt: '公司口径', escalate: '', guards: {}, memory: {}, skills: [], mcps: [] }
      ui.state.templateDraft = {
        prompt: '公司口径', escalate: '', skills: [], mcps: [], guards: [],
        memoryOn: true, scope: '所属分组', kinds: [], ttl: '90 天', cap: 20, confirmOn: true, piiOn: true,
      }
      ui.render()
      const html = ui.html()
      assert(html.includes('Bot 模版'), '公司侧没画出模版页')
      assert(html.includes('v3'), '没显示模版版本号')
      assert(html.includes('公司口径'), '模版正文没画出来')
      assert(html.includes('立即下发到全部席位'), '没有下发入口')
      assert(html.includes('全局'), '底下那张表没标出「全局」')
      assert(html.includes('已停用'), '没标出停用掉的老公司 Bot')
      // 公司管理员这一页不该再有「新建 Bot」——Bot 由员工自己建。
      assert(!html.includes('data-act="bot-create"'), '公司侧还留着建公司 Bot 的入口')

      /**
       * 席位同步那一格。**落后的那台必须点名**：只报一个「1/2」的比分，管理员知道有事
       * 却不知道是谁，下一步只能去按「立即下发」，而那会掐掉全公司正在进行的对话。
       */
      ui.state.templateSync = {
        version: 3,
        total: 2,
        synced: 1,
        seats: [
          { seatId: 's-2', botId: 'b2', accountId: 'a2', name: '李四', version: null, syncedAt: null },
          { seatId: 's-1', botId: 'b1', accountId: 'a1', name: '张三', version: 3, syncedAt: Date.now() - 60000 },
        ],
      }
      ui.render()
      const synced = ui.html()
      assert(synced.includes('席位同步'), '没画出同步那一格')
      assert(synced.includes('1/2 在 v3'), `比分没画对：${synced.includes('1/2') ? 'v?' : '没有比分'}`)
      assert(synced.includes('李四') && synced.includes('还没报到过'), '落后的那台没点名')
      assert(!synced.includes('张三'), '跟上的那台不该占地方')

      /**
       * **别人在你开着这一页时改了模版**：轮询拿回来的那份是服务端按新版本数的，而页面上
       * 这份 state.template 还停在你打开时的旧版本。这一格必须整个按服务端那份的
       * `sync.version` 算——混着用的话，「落后的有谁」按旧版本筛出空集，于是它画成绿色写
       * 「每台都在跑这一版」，而同一行的标签是「0/2」。
       */
      ui.state.templateSync = {
        version: 4,
        total: 2,
        synced: 0,
        seats: [
          { seatId: 's-1', botId: 'b1', accountId: 'a1', name: '张三', version: 3, syncedAt: Date.now() - 60000 },
          { seatId: 's-2', botId: 'b2', accountId: 'a2', name: '李四', version: 3, syncedAt: Date.now() - 60000 },
        ],
      }
      ui.render()
      const ahead = ui.html()
      assert(ahead.includes('0/2 在 v4'), `比分该按服务端那份的版本算：${ahead.includes('0/2') ? '版本号不对' : '没有比分'}`)
      assert(!ahead.includes('公司里每台已部署的席位都在跑这一版'), '一台都没跟上却说全跟上了')
      assert(ahead.includes('张三') && ahead.includes('李四'), '两台都落后，都该点名')
      // 没跟上的时候留一颗手动的「刷新」：自动刷新会在数字不动几轮之后停下来。
      assert(ahead.includes('data-act="tpl-sync-refresh"'), '停了自动刷新之后没有手动的路')

      // 员工那边接口不给这一格（state.templateSync 是 null），这时候整块都不该出现——
      // 空着一个「0/0」比没有更难懂。
      ui.state.templateSync = null
      ui.render()
      assert(!ui.html().includes('席位同步'), '没有同步数据时还画了那一格')
    })

    await test('只读地看别人维护的 Bot：页面上不留任何按了没反应的控件', async () => {
      // 「看着能按、按了不生效」比少一个控件更糟：人以为改上了，刷新一下又回去了。
      const ui = await boot(ownerToken)
      ui.state.me = { account: { role: 'admin', email: 'a@x' }, company: { id: 'org-1' }, settings: ui.state.settings }
      ui.state.path = '/bots/g1'
      ui.state.bot = { id: 'g1', name: '全局助理', origin: 'global', scope: 'global', enabled: true }
      ui.state.botDraft = {
        name: '全局助理', description: '', prompt: '平台口径', greeting: '', escalate: '', icon: 'g-core',
        model: 'm', enabled: true, skills: [], mcps: [], groups: [], kbs: [],
        guards: [{ id: 'pii', title: '拦截个人敏感信息', desc: '', on: true }],
        memoryOn: true, scope: '所属分组', kinds: ['偏好'], ttl: '90 天', cap: 20, confirmOn: true, piiOn: true,
      }
      ui.render()
      const html = ui.html()
      assert(html.includes('只读'), '保存键没标成只读')
      // 记忆那块的「记录哪些内容」曾经漏了这一条：药丸照常带着 bot-pick，点了会改草稿。
      assert(!html.includes('data-act="bot-pick"'), '只读页面上还留着可点的勾选药丸')
      assert(!html.includes('data-act="bot-guard"'), '只读页面上还留着可点的行为边界开关')
      assert(!html.includes('data-act="bot-scope"'), '只读页面上还留着可点的记忆范围')
    })

    await test('员工自己的 Bot：详情页只给身份和补充说明，底座只读', async () => {
      const ui = await boot(ownerToken)
      ui.state.me = { account: { role: 'member', email: 'm@x' }, company: { id: 'org-1' }, settings: ui.state.settings }
      ui.state.path = '/bots/u1'
      ui.state.bot = { id: 'u1', name: '回访助手', origin: 'company', scope: 'user', enabled: true, templateVersion: 3, extraPrompt: '带上客户名' }
      ui.state.botDraft = {
        name: '回访助手', description: '', prompt: '公司口径\n\n带上客户名', extraPrompt: '带上客户名',
        greeting: '', icon: 'c-bot', model: 'm', enabled: true, skills: [], mcps: [], guards: [],
        memoryOn: true, scope: '所属分组', kinds: [], ttl: '90 天', cap: 20, confirmOn: true, piiOn: true,
      }
      ui.state.template = { version: 3, prompt: '公司口径', escalate: '', guards: {}, memory: {}, skills: [], mcps: [] }
      assert(ui.pathAllowed('/bots/u1'), '员工进不了自己 Bot 的详情页')
      assert(!ui.pathAllowed('/bots'), '员工进得了管理员的模版页')
      ui.render()
      const html = ui.html()
      assert(html.includes('这个 Bot 的补充说明'), '没有补充说明那一栏')
      assert(html.includes('继承自公司模版'), '没说清楚底座从哪来')
      assert(html.includes('v3'), '没显示继承的是哪一版')
      // 底座那份提示词摆出来了，但不能是可编辑的。
      const soul = html.indexOf('公司口径')
      assert(soul > -1, '没把模版的人设摆出来')
      assert(html.slice(0, soul).lastIndexOf('disabled') > html.slice(0, soul).lastIndexOf('<textarea'), '模版正文是可编辑的')
    })

    await test('二级页面的头是「上一级 / 这一条」，返回在最前面', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/bots/b1'
      ui.state.bot = { id: 'b1', name: '测试 Bot', origin: 'global', enabled: true }
      ui.state.botDraft = { name: '测试 Bot', description: '', prompt: '', provider: 'p', model: 'm', enabled: true, icon: 'g-core', skills: [], mcps: [] }
      ui.render()
      const html = ui.html()
      assert(html.includes('satu-crumbs'), '没画面包屑')
      assert(html.includes('>全局 Bot</button>'), '上一级不是「全局 Bot」')
      assert(html.includes('>测试 Bot</span>'), '当前这一级不是 Bot 的名字')
      // 返回要在面包屑前面：DOM 顺序就是视觉顺序，这一条能拦住「又挪回右边」。
      const back = html.indexOf('aria-label="返回"')
      assert(back > -1, '头上没有返回按钮')
      assert(back < html.indexOf('satu-crumbs'), '返回跑到面包屑后面去了')
      assert(!html.includes('返回 Bot 列表'), '右边那条旧的返回还在')

      // 名字对不上就不能顶着上一条的名字——列表页留在内存里的那份最容易漏。
      ui.state.path = '/bots/b2'
      ui.render()
      assert(!ui.html().includes('>测试 Bot</span>'), '换了一条还画着上一条的名字')
      assert(ui.html().includes('Bot 详情'), '没退回泛称')
    })

    await test('账单页两张余额卡并排：赠送的在前，账户合计在后', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/billing'
      ui.state.billing = {
        plan: { name: '标准版', period: '2026-08-01 → 2026-09-01' },
        invoices: [],
        topups: [],
        // 发放 $200 + $150，已扣 $40，还剩 $310。**大字画的是剩的，不是发的**。
        balance: {
          amount: '$350.00', planBonus: '$200.00', planBonusExpires: '2026-09-01', topup: '$150.00',
          planBonusLeft: '$160.00', topupLeft: '$150.00', left: '$310.00', leftMicros: 310_000_000,
          grantedMicros: 350_000_000, spentThisPeriod: '$40.00', alertAt: '—', enforce: true,
        },
      }
      ui.render()
      const html = ui.html()
      const bonus = html.indexOf('套餐赠送余额')
      const account = html.indexOf('账户余额')
      assert(bonus > -1 && account > -1, '两张卡没都画出来')
      assert(bonus < account, '赠送那张跑到账户余额后面去了')
      assert(html.includes('$310.00') && html.includes('$160.00') && html.includes('$150.00'), '剩余额没都画出来')
      assert(html.includes('本期已扣 $40.00'), '已扣没画出来')
      // 发放额也要在，但只能是小字——只报发放额的话那个数永远不动。
      assert(html.includes('$200.00'), '本期发放没画出来')
      assert(html.includes('2026-09-01 到期'), '到期日没画出来')
      assert(!html.includes('额度已用完'), '还有钱却报了熔断')
      // 并排靠 auto-fit 网格，窄了自己叠成一列；写死两列会在窄屏上挤成一团。
      assert(html.includes('repeat(auto-fit, minmax(280px, 1fr))'), '不是自适应两列')
    })

    await test('没有生效中的套餐：赠送那张写清楚，不显示一个空的到期日', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/billing'
      ui.state.billing = {
        plan: {},
        invoices: [],
        topups: [],
        balance: {
          amount: '$0.00', planBonus: '$0.00', planBonusExpires: '—', topup: '$0.00',
          planBonusLeft: '$0.00', topupLeft: '$0.00', left: '$0.00', leftMicros: 0,
          grantedMicros: 0, spentThisPeriod: '$0.00', alertAt: '—', enforce: true,
        },
      }
      ui.render()
      const html = ui.html()
      assert(html.includes('没有生效中的套餐'), '空态没写清楚')
      assert(!html.includes('— 到期'), '把「—」当成到期日画出来了')
      // 余额 0 且熔断开着：这一屏必须说出「调用已经停下来了」，不能只画一个 $0.00。
      assert(html.includes('额度已用完'), '余额见底没给告警')
    })

    await test('余额告警的措辞跟着 enforce 变：真停了和只记账不拦是两件事', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/billing'
      const base = {
        amount: '$0.00', planBonus: '$0.00', planBonusExpires: '—', topup: '$0.00',
        planBonusLeft: '$0.00', topupLeft: '$0.00', left: '$0.00', leftMicros: 0,
        grantedMicros: 100_000_000, spentThisPeriod: '$100.00', alertAt: '—',
      }
      ui.state.billing = { plan: {}, invoices: [], topups: [], balance: { ...base, enforce: false } }
      ui.render()
      assert(ui.html().includes('调用还在继续'), 'enforce 关着却说停了')

      // 还剩不到一成：提醒，但别说已经停了——那时人还来得及去充。
      ui.state.billing = {
        plan: {}, invoices: [], topups: [],
        balance: { ...base, enforce: true, left: '$5.00', leftMicros: 5_000_000 },
      }
      ui.render()
      const low = ui.html()
      assert(low.includes('还剩不到一成'), '低余额没提醒')
      assert(!low.includes('额度已用完'), '还有钱却说用完了')
    })

    await test('原地重绘不丢滚动位置；换了页面才回到顶部', async () => {
      // Bot 详情上按一个开关（记忆范围、勾选项、上线…）走的都是整页重绘。
      // 不把位置贴回去，人就被扔回页首——页面越长越难受。
      const ui = await boot(ownerToken)
      ui.state.path = '/bots/b1'
      ui.state.bot = { id: 'b1', name: '测试 Bot', origin: 'global', enabled: true }
      ui.state.botDraft = { name: '测试 Bot', description: '', prompt: '', provider: 'p', model: 'm', enabled: true, icon: 'g-core', skills: [], mcps: [], memoryOn: true, scope: '仅本人', kinds: [], ttl: '90 天', cap: 20, guards: [] }
      ui.render()

      ui.page.scrollTop = 640
      ui.state.botDraft = { ...ui.state.botDraft, scope: '全公司' }
      ui.render()
      assert(ui.page.scrollTop === 640, `原地重绘把人扔回了 ${ui.page.scrollTop}`)

      ui.state.path = '/bots'
      ui.render()
      assert(ui.page.scrollTop === 0, `换页没回到顶部：${ui.page.scrollTop}`)
    })

    await test('一级页面的头照旧是单标题，不出面包屑', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/bots'
      ui.render()
      assert(!ui.html().includes('satu-crumbs'), '一级页面画出了面包屑')
      assert(!ui.html().includes('aria-label="返回"'), '一级页面出现了返回按钮')
    })

    let adminToken = ''
    await test('登出清空聊天状态：同一标签页换人登录，看不到上一个人的对话', async () => {
      // 登出以前只清了账号相关的字段，聊天正文、草稿、助理名册都原样留在内存里。
      // 同一台电脑换个人登录，上一个人的对话会直接画在他面前——SSE 要是还连着，
      // 新的事件也照样往里落。
      const reg = await createCompany(req, gwBase, {
        ownerToken,
        email: 'admin@ui.test',
        password: 'correct-horse-2',
        companyName: 'UI',
        slug: 'ui-co',
        seats: 2,
      })
      adminToken = reg.token

      const ui = await boot(adminToken)
      ui.state.chatBotId = 'bot-x'
      ui.state.chatSessionId = 's-previous-user'
      ui.state.chatEvents = [
        { type: 'user/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'UI-SMOKE-上一个人说的' }] } } },
      ]
      ui.state.chatDraft = 'UI-SMOKE-没发出去的草稿'
      ui.state.runtimeBots = [{ id: 'bot-x', name: 'UI-SMOKE-上一个人的助理' }]

      await ui.fire('click', el('button', { 'data-act': 'logout' }))

      assert(ui.state.chatEvents.length === 0, `聊天正文没清：${JSON.stringify(ui.state.chatEvents)}`)
      assert(ui.state.chatDraft === '', `草稿没清：${ui.state.chatDraft}`)
      assert(ui.state.chatSessionId === '', `会话 id 没清：${ui.state.chatSessionId}`)
      assert(ui.state.chatBotId === '', `botId 没清：${ui.state.chatBotId}`)
      assert((ui.state.runtimeBots || []).length === 0, '助理名册没清')
      const html = ui.html()
      assert(!html.includes('UI-SMOKE-上一个人说的'), '登出后页面上还留着上一个人的对话')
      assert(!html.includes('UI-SMOKE-没发出去的草稿'), '登出后页面上还留着上一个人的草稿')
    })

    await test('新建 Bot 的运行位置：选哪个，红框和按钮就跟到哪个', async () => {
      const ui = loadApp({ appPath, base: gwBase, token: adminToken, desktop: true })
      await ui.boot()
      await ui.fire('click', el('button', { 'data-act': 'new-bot' }))

      const selected = (html, value) => new RegExp(
        `<label class="satu-card" style="[^"]*border-color:var\\(--primary\\)[^"]*;">\\s*<input[^>]*value="${value}"[^>]*checked`,
      ).test(html)

      assert(selected(ui.html(), 'remote'), '默认选远程时，红框没有落在远程 Bot')
      await ui.fire('input', el('input', { 'data-newbot': 'runtimeKind' }, 'local'))
      assert(ui.state.newBot.runtimeKind === 'local', '点击本地后，表单值没有切到本地')
      assert(selected(ui.html(), 'local'), '点击本地后，红框没有切到本地 Bot')
      assert(ui.html().includes('创建并启动'), '点击本地后，底部按钮没有同步切换')

      await ui.fire('input', el('input', { 'data-newbot': 'runtimeKind' }, 'remote'))
      assert(selected(ui.html(), 'remote'), '切回远程后，红框没有回到远程 Bot')
      assert(ui.html().includes('创建并安装'), '切回远程后，底部按钮没有同步切换')
    })

    await test('本地 Bot 启动失败要把真实原因画出来，不能永远停在等待 Desktop', async () => {
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        desktop: true,
        localBotBridge: {
          start: async () => { throw new Error('本地 Bot 启动后立即退出：测试日志') },
        },
        fetchImpl: async (path) => {
          if (path === '/runtime/bots/local-1/local-bootstrap') {
            return new Response(JSON.stringify({
              botId: 'local-1', gatewayUrl: gwBase, accessToken: 'sat_test', apiKey: 'sk_sw_test',
            }), { status: 200, headers: { 'content-type': 'application/json' } })
          }
          return new Response(JSON.stringify({ error: `unexpected ${path}` }), {
            status: 404, headers: { 'content-type': 'application/json' },
          })
        },
      })
      ui.state.path = '/a/local-1'
      ui.state.runtimeBots = [{
        id: 'local-1', name: 'Mac 助手', runtimeKind: 'local',
        runtime: { kind: 'local', status: 'none', machineLink: 'offline' },
      }]
      await ui.fire('click', el('button', { 'data-act': 'local-bot-start', 'data-bot': 'local-1' }))
      assert(ui.state.deployHint.includes('启动后立即退出'), `启动原因没有留下：${ui.state.deployHint}`)
      assert(ui.chatDeployPrompt('local-1').includes('启动后立即退出'), '启动原因没有画在等待卡片上')
    })

    await test('本地 Bot 在跑：登录票没换就不再要票；换过（重新登录、改了口令）就重新要、交给壳子换票', async () => {
      // 本地 Bot 的票跟登录票同生共死（Gateway 迁移 0041）：改口令、被重置之后，进程手上那把
      // 已经作废。页面这时一定换了一张登录票——拿它当信号重新要一次，交给壳子的 start
      // （同一把不动，换了一把就用新票重起），页面直连也改用新的那把。
      let issued = 0
      const starts = []
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: 'jwt-before',
        desktop: true,
        localBotBridge: {
          status: async () => ({ running: true, port: 41001, workspace: '/w' }),
          start: async (cfg) => {
            starts.push(cfg.accessToken)
            return { running: true, port: 41002 }
          },
        },
        fetchImpl: async (path) => {
          if (path === '/runtime/bots/local-1/local-bootstrap') {
            issued += 1
            return new Response(JSON.stringify({
              botId: 'local-1', gatewayUrl: gwBase, accessToken: `sat_v${issued}`, apiKey: `sk_sw_v${issued}`,
            }), { status: 200, headers: { 'content-type': 'application/json' } })
          }
          return new Response(JSON.stringify({ error: `unexpected ${path}` }), {
            status: 404, headers: { 'content-type': 'application/json' },
          })
        },
      })
      const bots = () => [{ id: 'local-1', name: 'Mac 助手', runtimeKind: 'local' }]
      const direct = () => ui.localRoute('/runtime/bots/local-1/session', 'GET')

      const first = bots()
      await ui.overlayLocalRuntime(first)
      assert(issued === 1 && starts.join() === 'sat_v1', `页面刚打开该要一次票并交给壳子：issued=${issued} starts=${starts}`)
      assert(first[0].runtime.port === 41002, `壳子回的口没用上：${first[0].runtime.port}`)
      assert(direct()?.token === 'sat_v1', `直连该用刚要来的票：${JSON.stringify(direct())}`)

      await ui.overlayLocalRuntime(bots())
      assert(issued === 1 && starts.length === 1, `登录票没换，不该再要票：issued=${issued} starts=${starts}`)

      ui.setToken('jwt-after')
      await ui.overlayLocalRuntime(bots())
      assert(issued === 2 && starts.join() === 'sat_v1,sat_v2', `登录票换了该重新要票、交给壳子：issued=${issued} starts=${starts}`)
      assert(direct()?.token === 'sat_v2', `直连该换成新票：${JSON.stringify(direct())}`)
    })

    await test('Bot 名单在非对话页也要在——它是顶层导航，不是对话页的附属', async () => {
      // 名单从「对话」子项提到侧栏顶层之后，取数的路径没跟着搬：loadRuntimeBots 一直
      // 只在 loadChatPage 里跑。于是管理员一进概览页（首页就是概览，根本不走那条路），
      // 侧栏上的 Bot 就整片消失了——而它现在是这个产品的主导航。
      // 先保证这位管理员名下有一个 Bot：不然下面「画进侧栏」那两条永远走不到，
      // 用例看着绿，实际只验了「取过了」。管理员也是员工，自己建一个就行。
      const made = await req(gwBase, 'POST', '/runtime/bots', { token: adminToken, body: { name: 'UI-SMOKE-侧栏用的 Bot' } })
      assert(made.status === 201, `建 Bot ${made.status} ${made.text}`)
      const ui = loadApp({ appPath, base: gwBase, token: adminToken })
      await ui.boot()
      assert(ui.state.path === '/', `管理员首页应是概览，实际 ${ui.state.path}`)
      assert(Array.isArray(ui.state.runtimeBots), '非对话页也该把名单取回来')
      assert(ui.state.runtimeBots.some((b) => b.id === made.json.bot.id), '刚建的 Bot 不在名单里')
      const html = ui.html()
      assert(html.includes('satu-botrow'), '名单取回来了却没画进侧栏')
      assert(html.includes('satu-botdot'), '状态点没画')
    })

    await test('公司分类默认折叠，点一下展开，再点一下收回', async () => {
      /**
       * **默认是折叠的**（state.js 的 navGroupOpen）：那八条是偶尔才去一趟的后台，
       * 而它们上面就是每天要点的 Bot 名单——默认摊开八行，名单会被挤得只剩两三个。
       *
       * 头两条钉的就是这个默认值：折叠按钮在（没有它就再也展不开了），可那些入口
       * 一个都没画。**两条都要**——只验 aria-expanded 的话，哪天 render 改成「折叠
       * 时照画、只用 CSS 藏」，这条用例照样绿，而侧栏上仍然堆着八行。
       */
      const ui = await boot(adminToken)
      let html = ui.html()
      assert(/data-act="nav-group-toggle"[^>]*aria-expanded="false"/.test(html), '公司分类默认不是折叠态')
      assert(!html.includes('data-href="/company"'), '默认折叠，却把公司菜单入口画出来了')

      await ui.fire('click', el('button', { 'data-act': 'nav-group-toggle', 'data-group': 'company' }))
      html = ui.html()
      assert(/data-act="nav-group-toggle"[^>]*aria-expanded="true"/.test(html), '点击后没有展开')
      assert(html.includes('data-href="/company"'), '展开后没有画公司菜单入口')

      await ui.fire('click', el('button', { 'data-act': 'nav-group-toggle', 'data-group': 'company' }))
      html = ui.html()
      assert(/data-act="nav-group-toggle"[^>]*aria-expanded="false"/.test(html), '第二次点击没有收回')
      assert(!html.includes('data-href="/company"'), '收回后公司菜单入口仍然可见')
    })

    await test('公司侧没有「供应商」：菜单里没有，直接输地址也进不去', async () => {
      /**
       * 供应商只由平台配（gateway/src/llm.ts 的 secret：平台密钥 > 环境变量）。公司
       * 这一侧曾经有一整页——管理员贴本公司的 key、员工只读——现在整页撤了。
       *
       * **两头都要验**：只撤菜单不撤放行的话，页面还在，直接输 `/providers` 就能进
       * 到一个「有输入框、保存必定 404」的屏；只撤放行不撤菜单则是一条点了就被踢回
       * 首页的菜单项。
       */
      const ui = await boot(adminToken)
      // **先把「公司」那组展开**。它默认是折叠的（state.js 的 navGroupOpen），折叠时
      // 那八条一条都不画——不展开的话，下面那条「菜单里没有供应商」是**永远成立**的：
      // 哪天有人把 /providers 加回 ADMIN_NAV，这条用例照样绿。
      await ui.fire('click', el('button', { 'data-act': 'nav-group-toggle', 'data-group': 'company' }))
      const menu = ui.html()
      assert(menu.includes('data-href="/billing"'), '公司那组没展开，下面那条断言就没意义了')
      assert(!menu.includes('data-href="/providers"'), '公司菜单里还有「供应商」')
      assert(!ui.pathAllowed('/providers'), '公司侧 /providers 仍然放行')
      // 平台那一侧不受影响：owner 还得在那一页配密钥。
      const own = await boot(ownerToken)
      assert(own.pathAllowed('/providers'), 'owner 的 /providers 被一起撤掉了')
    })

    await test('侧栏把「插件」和「渠道」收进了「新建 Bot」旁边那颗「更多」', async () => {
      /**
       * 三条一样宽的虚线框叠在 Bot 名单底下，占三行高，而名单才是这一屏的主体。
       * 「插件」「渠道」一天也点不了一次，却和每天都要点的「新建 Bot」长得一模一样。
       *
       * 这条钉三件事，少一件这个改动就白做了：**平时看不见**（不是换了个地方还摆着）、
       * **点得开**、**点完就收**（不收的话跳到渠道页之后它还浮在侧栏上）。
       */
      const ui = await boot(adminToken)
      let html = ui.html()
      assert(html.includes('data-id="botmore"'), '「新建 Bot」旁边没有那颗「更多」')
      assert(!html.includes('class="satu-menu"'), '还没点就把菜单画出来了')
      // 那两条平时只以**导轨兜底**的形态留在 DOM 里（62px 宽的侧栏装不下 168px 的
      // 浮层，所以那一档摊成两行，靠 CSS 分辨，见 app.css 的 .satu-newbot-rail）。
      // 少了这个类名，它们就又是名单底下两行一样宽的虚线框——正是这次要去掉的东西。
      const railBtns = html.match(/<button[^>]*satu-newbot-rail[^>]*>/g) || []
      assert(railBtns.some((b) => b.includes('data-act="plugins-open"')), '「插件」没收进「更多」，仍然单独占一行')
      assert(railBtns.some((b) => b.includes('data-href="/channels"')), '「渠道」没收进「更多」，仍然单独占一行')

      await ui.fire('click', el('button', { 'data-act': 'menu-toggle', 'data-id': 'botmore' }))
      html = ui.html()
      const menuAt = html.indexOf('class="satu-menu"')
      assert(menuAt >= 0, '点了「更多」菜单没出来')
      const menu = html.slice(menuAt, html.indexOf('</div>', menuAt))
      assert(menu.includes('data-act="plugins-open"'), '菜单里没有「插件」')
      assert(menu.includes('data-href="/channels"'), '菜单里没有「渠道」')

      await ui.fire('click', el('button', { 'data-act': 'go', 'data-href': '/channels' }))
      assert(ui.state.path === '/channels', `点「渠道」没跳过去，实际 ${ui.state.path}`)
      assert(ui.state.menu == null, '跳走之后菜单还开着')
    })

    await test('侧栏已移除任务看板，渠道页只提供 Telegram 绑定', async () => {
      const ui = await boot(adminToken)
      let html = ui.html()
      const channelsAt = html.indexOf('data-href="/channels"')
      assert(!html.includes('data-href="/tasks"'), '侧栏仍然显示任务看板')
      assert(channelsAt >= 0, '侧栏没有渠道入口')
      assert(!ui.pathAllowed('/tasks'), '已删除的任务看板路径仍被放行')

      ui.state.path = '/channels'
      ui.state.channels = []
      ui.render()
      html = ui.html()
      assert(html.includes('绑定 Telegram'), '渠道页没有 Telegram 绑定入口')
      assert(!html.includes('微信') && !html.includes('WeChat'), '渠道页仍然显示微信扩展位')

      ui.state.channels = [{
        id: 'tg-1', kind: 'telegram', status: 'active', botId: 'bot-tg', externalUsername: 'demo_bot',
        allowGroups: false, paired: false, pairingCode: 'ABCD-2345', bot: { name: 'telegram bot' }, runtime: { status: 'ready' },
      }]
      ui.render()
      html = ui.html()
      assert(html.includes('等待配对'), '未配对渠道没有显示等待状态')
      assert(html.includes('ABCD-2345'), '页面没有显示一次性配对码')
      assert(html.includes('任何消息都不会进入 AI'), '没有说明配对前消息不会进入模型')
    })

    await test('平台菜单里没有「全局 Bot」，但那一页 owner 仍然进得去', async () => {
      // 撤的是**入口**，不是功能。这两条断言必须一起看：只删菜单项的话，
      // allowedHrefs 跟着少一项，pathAllowed('/bots') 变 false，owner 直接输地址会被
      // 踢回首页——全局 Bot 目录从此没人改得动，而他是唯一改得动的人。
      const ui = await boot(ownerToken)
      assert(!ui.html().includes('全局 Bot'), '平台菜单里还挂着「全局 Bot」')
      assert(ui.pathAllowed('/bots'), '把页面一起封掉了：owner 进不去全局 Bot')
      assert(ui.pathAllowed('/bots/some-id'), '详情页也被封了')
      // 公司侧不受影响：那边的 Bot 名录本来就该在菜单里。
      const admin = await boot(adminToken)
      assert(admin.pathAllowed('/bots'), '公司管理员的 Bot 页被误伤')
    })

    await test('平台侧栏没有 Bot 名单时，菜单贴着顶，不被占位压到底部', async () => {
      // 「导航沉底」的理由是给 Bot 名单让位。owner 永远没有名单（没席位，/runtime/bots
      // 对他 403），占位却照撑满，结果是菜单被压到屏幕最下面、上面空一大片。
      const ui = await boot(ownerToken)
      const html = ui.html()
      assert(!html.includes('satu-botlist'), 'owner 侧栏不该有 Bot 名单')
      // navfoot 前面不许再有别的兄弟——有就是占位又回来了。
      assert(
        /<div style="flex: 1; min-height: 0;[^"]*">\s*<div class="satu-navfoot">/.test(html),
        '菜单前面还夹着一个撑满高度的占位',
      )
    })

    await test('员工侧栏没有 Bot 时，「新建 Bot」不许顶到品牌标底下', async () => {
      // 占位是按「这一侧有没有名单」留的，不是按「此刻有没有 Bot」。跟着 Bot 一起收掉
      // 的话，删完最后一颗的那一瞬间「新建 Bot」和「插件」会从名单下沿弹到最上面，
      // 整个侧栏跳一下——而对话区那句空态写的正是「点左下角「新建 Bot」」。
      const ui = await boot(adminToken)
      ui.state.runtimeBots = []
      ui.render()
      const html = ui.html()
      assert(html.includes('satu-botlist'), '名单空了，占位跟着没了')
      assert(!html.includes('satu-botrow'), '没有 Bot 却画出了名单行')
      assert(
        html.indexOf('satu-botlist') < html.indexOf('satu-newbot'),
        '「新建 Bot」跑到名单占位前面去了',
      )
    })

    await test('长列表分页：一页 20 条，越界夹回，筛选之后回到第一页', async () => {
      // 这几张表是一次拉齐、前端切页的。切页最容易出的两种错都在这里钉住：
      // **越界**（数据变少了还停在第 7 页，人看到一片空白）和**筛选之后不回第一页**
      // （点了「只看在线」，结果因为停在第 3 页而一台都没有）。
      const ui = await boot(ownerToken)
      const rowsIn = (html) => (html.match(/class="satu-memberrow"/g) || []).length
      ui.state.orgs = Array.from({ length: 47 }, (_, i) => ({ id: 'org-' + i, name: '公司' + i, slug: 'c' + i, plan: {} }))
      ui.state.path = '/companies'
      ui.render()
      let html = ui.html()
      assert(rowsIn(html) === 20, `第一页画了 ${rowsIn(html)} 行，不是一页 20 条`)
      assert(html.includes('共 47 家'), `总数没说清：${html.slice(html.indexOf('satu-pager'), html.indexOf('satu-pager') + 200)}`)
      assert(html.includes('第 1 / 3 页'), '页码没画出来')

      ui.state.listPage.companies = 3
      ui.render()
      html = ui.html()
      assert(rowsIn(html) === 7, `最后一页该是 7 行，实际 ${rowsIn(html)}`)

      // 越界：数据缩水（删了一批、或者上一次看的是别的筛选）之后不能留在空页上。
      ui.state.listPage.companies = 99
      ui.render()
      html = ui.html()
      assert(html.includes('第 3 / 3 页'), '越界的页码没被夹回最后一页')
      assert(rowsIn(html) > 0, '夹回之后还是一页空白')

      // 一页装得下时只报总数，不画两颗永远点不动的翻页按钮。
      ui.state.orgs = ui.state.orgs.slice(0, 5)
      ui.render()
      html = ui.html()
      assert(html.includes('共 5 家'), '总数一直要在')
      assert(!html.includes('data-act="list-page"'), '只有一页却画了翻页按钮')

      // 机器：先筛后分页，而顶上那排计数仍然按全量算——它答的是「这一档有几台」，
      // 跟着当前页变的话「失联 3 台」会在翻页时变成 1 台，那是句假话。
      ui.state.allMachines = Array.from({ length: 47 }, (_, i) => ({
        machine: { id: 'm' + i, host: '10.0.0.' + i, paired: true, link: i % 3 === 0 ? 'online' : 'offline' },
        accounts: 1, maxAccounts: 4, seats: 1, company: null,
      }))
      ui.state.machineTotals = { machines: 47, paired: 47, online: 16, accounts: 47, max: 188, seats: 47 }
      ui.state.path = '/machines'
      ui.state.listPage.machines = 3
      ui.render()
      assert(ui.html().includes('第 3 / 3 页'), '机器表没停在第 3 页，后面那条断言就没意义了')
      await ui.fire('click', el('button', { 'data-act': 'machine-filter', 'data-filter': 'online' }))
      html = ui.html()
      assert(html.includes('共 16 台'), `筛完的总数不对：${html.slice(html.indexOf('satu-pager'), html.indexOf('satu-pager') + 120)}`)
      assert(rowsIn(html) === 16, `筛完该看到 16 行，实际 ${rowsIn(html)}——多半是还停在第 3 页`)
      assert(/data-filter="online"[^>]*>[^<]*16/.test(html), '顶上那排计数被分页带歪了')
    })

    await test('平台菜单是分组的，且分组没有吃掉任何一条入口', async () => {
      // 十几条平铺是找不到落点的。分组之后要盯住两件事：**组还在**（有人把标题删了，
      // 菜单就退回一根柱子），以及**条目一条不少**——漏一条的表现是那一页从此没有入口，
      // 而页面还在、地址还通，翻遍界面也找不到它。
      const ui = await boot(ownerToken)
      const html = ui.html()
      const groups = [...html.matchAll(/<div class="satu-navgroup">([\s\S]*?)<\/div>/g)].map((m) => m[1])
      assert(groups.length >= 4, `平台菜单只剩 ${groups.length} 组，分组没生效`)
      const titled = groups.filter((g) => g.includes('satu-group'))
      assert(titled.length === groups.length - 1, '除了「概览」那一组，每组都该有标题')
      const inGroups = groups.reduce((n, g) => n + (g.match(/class="satu-nav"/g) || []).length, 0)
      const all = (html.match(/class="satu-nav"/g) || []).length
      assert(inGroups === all, `有 ${all - inGroups} 条入口掉在了所有分组外面`)
      // 「先看哪台机器出事，再谈给它发什么包」——这两条是一组里的一对，不能被拆散。
      const machines = groups.find((g) => g.includes('机器管理'))
      assert(machines && machines.includes('机器配置'), '机器管理和机器配置被分到了两组')
    })

    await test('通联灯：后端没给 link 时说「状态未知」，不谎称「还没有配对」', async () => {
      // 前端比后端新一步时（浏览器读磁盘上的 app.js，Gateway 要重启才换代码）响应里
      // 没有 link 这个字段。原来的兜底是 `m.link || 'unpaired'`，于是一台心跳正常、
      // 版本刚升完的机器，头一行写着「还没有配对」——把「字段缺席」和「机器没配对」
      // 混成同一个结论，而这两件事差得最远。
      const ui = await boot(ownerToken)
      const stale = ui.machineHead('org-1', { no: 1 }, { id: 'abcdef0123', paired: true })
      assert(stale.includes('状态未知'), `缺 link 时该说不知道，实际：${stale}`)
      assert(!stale.includes('还没有配对'), '对一台已配对的机器谎称没配对')
      // paired 是老响应里就有的，可信：它说没配对，那就是真没配对。
      const virgin = ui.machineHead('org-1', { no: 2 }, { id: 'abcdef0123', paired: false })
      assert(virgin.includes('还没有配对'), '真没配对时反而不说了')
      // 编号缺席就整个略过——「机器 ?」既指代不了机器，也说不清哪儿出了问题。
      const noNo = ui.machineHead('org-1', {}, { id: 'abcdef0123', paired: true, link: 'online' })
      assert(!noNo.includes('?'), `编号缺席时画出了问号：${noNo}`)
      assert(noNo.includes('abcdef01'), '短码也一起没了')
      // 刷新那颗要挂着公司 id：机器那个接口是按公司回整张列表的，没有 id 就无处可拉。
      assert(
        /data-act="machine-refresh"[^>]*data-id="org-1"/.test(stale),
        `刷新按钮没带上公司 id：${stale}`,
      )
    })

    await test('用户列表：状态那一格有东西，能按着停用；自己和待接受的不给按钮', async () => {
      /**
       * 这一页原来最后两列是**空的**（表头两个 `<span></span>`，行里两个 `<div></div>`），
       * 于是「这个人还能不能登录」在全平台唯一列全部账号的这一页上看不见，也改不了。
       *
       * 按钮该不该出现是这条用例的重点：
       *  - 自己那一行不能有——把自己停掉之后下一次请求就 401，谁也开不回来（服务端也挡）
       *  - 待接受那一行不能有「启用」——口令得由本人用邀请链接设
       */
      const ui = await boot(ownerToken)
      ui.state.path = '/users'
      const meId = ui.state.me?.account?.id || 'me-1'
      ui.state.users = [
        { id: meId, email: 'owner@x.com', name: '我自己', role: 'owner', status: 'active', createdAt: Date.now() - 86400000, company: null },
        { id: 'u-active', email: 'a@acme.test', name: '在职的', role: 'admin', status: 'active', createdAt: Date.now() - 86400000, company: { id: 'c1', name: 'Acme', slug: 'acme' } },
        { id: 'u-off', email: 'b@acme.test', name: '停用的', role: 'member', status: 'disabled', createdAt: Date.now() - 86400000, company: { id: 'c1', name: 'Acme', slug: 'acme' } },
        { id: 'u-inv', email: 'c@acme.test', name: '待接受的', role: 'member', status: 'invited', createdAt: Date.now() - 3600000, company: { id: 'c1', name: 'Acme', slug: 'acme' } },
      ]
      ui.render()
      const html = ui.html()
      assert(html.includes('已激活') && html.includes('已停用') && html.includes('待接受'), '状态那一格还是空的')
      assert(html.includes('data-act="user-status" data-id="u-active" data-next="disabled"'), '在职的那行没有「停用」')
      assert(html.includes('data-act="user-status" data-id="u-off" data-next="active"'), '停用的那行没有「启用」')
      assert(!html.includes('data-id="u-inv"'), '待接受的那行不该给状态按钮')
      assert(!html.includes(`data-act="user-status" data-id="${meId}"`), '自己那行不该给状态按钮')
    })

    await test('内网 http 页面上复制邀请链接：走 execCommand 兜底，不再一点就报失败', async () => {
      /**
       * 复制原来只有 navigator.clipboard 一条路。那个对象在规范里标了 [SecureContext]：
       * http://192.168.x.x:3080 这种内网地址上它**整个不存在**，writeText 不是被拒，是
       * 直接抛。于是邀请弹窗里点几次都只有「复制失败，请手动选中上面的链接复制。」——
       * 而内网 http 恰恰是 Gateway 最常见的部署形态，等于这颗按钮在真实现场一直是坏的。
       *
       * 所以这里把垫片调成非安全上下文（navigator 上没有 clipboard），再点那颗
       * 「再复制一次」，验兜底那条路真的把链接送出去了，而且没在 body 里留下垃圾。
       */
      const ui = await boot(ownerToken, { secureContext: false })
      const link = 'http://192.168.64.1:3080/join/yTfTxGXYTuTs4aUPkCyINoOn4J'
      ui.state.path = '/accounts'
      ui.state.inviteOpen = true
      ui.state.inviteLink = link
      ui.state.inviteCopied = false
      ui.state.inviteError = '复制失败，请手动选中上面的链接复制。'
      ui.render()

      // 那颗按钮是 form 的 submit，不是 data-act——走 app.js 真的那条分流。
      const form = el('form')
      form.id = 'invite-form'
      await ui.fire('submit', form)

      assert(ui.copied.includes(link), `兜底没把链接复制出去：${JSON.stringify(ui.copied)}`)
      assert(ui.state.inviteCopied === true, '复制成了，按钮却没切成「已复制」')
      assert(!ui.state.inviteError, `复制成了还留着失败提示：${ui.state.inviteError}`)
      assert(ui.body.children.length === 0, '兜底用完没把那个隐形 textarea 撤掉')
    })

    await test('内网 http 页面上复制机器编号：复制得出来，且一定有话说', async () => {
      /**
       * 这一处原来写的是 `navigator.clipboard?.writeText(id).then(成功, 失败)`。
       * `?.` 短路掉的是**整条链**，不只是那一步：内网 http 上 clipboard 不存在，于是
       * `.then` 的两个回调一个都不跑——既没复制成，也一个字不说。而它旁边那行注释写的
       * 正是「失败必须说话，静默复制失败之后人会照着屏幕上那 8 位去用，那不是完整 id」。
       *
       * 所以这条验两件事：兜底真的把整串 id 复制出去了；以及万一还是失败，提示条上有话。
       */
      const ui = await boot(ownerToken, { secureContext: false })
      const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      await ui.fire('click', el('button', { 'data-act': 'copy-machine-id', 'data-machine': id }))

      assert(ui.copied.includes(id), `机器编号没复制出去：${JSON.stringify(ui.copied)}`)
      assert(ui.state.notice === '已复制机器编号', `复制成了却没说话：notice=${JSON.stringify(ui.state.notice)} error=${JSON.stringify(ui.state.error)}`)
      assert(ui.body.children.length === 0, '兜底用完没把那个隐形 textarea 撤掉')
    })

    await test('公司详情页：机器报了负载也画得出来，不是整页白屏', async () => {
      /**
       * 这一页曾经整页画不出来：机器卡片里那格负载的渲染函数（machineLoadCell）在
       * 「机器列表砍掉负载那一列」时被一并删掉，而它**还有第二个调用方**——就是这里。
       * 于是只要那台机器报过负载，整页抛 ReferenceError，屏幕上停在上一屏，控制台之外
       * 一个字都没有。
       *
       * 所以这条断言的不是某一行长什么样，而是**这一页画得出来**：owner 侧最常点开的
       * 一页，此前在 ui-smoke 里一条覆盖都没有。
       */
      const ui = await boot(ownerToken)
      ui.state.path = '/companies/org-1'
      ui.state.org = {
        id: 'org-1', name: 'UI-SMOKE-公司', slug: 'smoke', status: 'active',
        contactName: '张三', contactPhone: '+65 68886888', contactEmail: 'a@x.com',
        address: '', website: '', accessUrl: '', createdAt: Date.now() - 86400000, machineId: null,
      }
      ui.state.plan = { seats: 3, used: 2, expiresAt: Date.now() + 86400000 }
      ui.state.seats = { total: 3, used: 2 }
      ui.state.accounts = [{ id: 'a1', name: '李四', email: 'l@x.com', role: 'member', status: 'active', lastSeenAt: Date.now() - 60000, runtimes: [] }]
      ui.state.billing = { plan: { period: '月付', amount: '$200.00' }, invoices: [] }
      // 拉不到的那几份在真实加载里也是这些默认值（各自带 .catch），照抄过来。
      ui.state.charges = null
      ui.state.orgTopups = []
      ui.state.planSkus = []
      ui.state.releases = []
      ui.state.latestRelease = null
      ui.state.machines = [{
        no: 1,
        machine: {
          id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', host: 'http://10.0.0.12:8443', paired: true,
          pairedAt: Date.now(), managerVersion: '0.3.1+abc-arm64', protocol: 1, lastError: null,
          lastHeartbeatAt: Date.now() - 12000, link: 'online', heartbeatAge: 12000,
          timezone: null, currentTimezone: 'Asia/Singapore', arch: 'arm64',
          // 报过负载的机器**才**触发那一格。盘 92%：和列表页那个 fixture 同一个数。
          telemetry: {
            metrics: {
              uptime: 3600,
              cpu: { cores: 8, usage: 0.23, load1: 1.8 },
              memory: { total: 16 * 1024 ** 3, used: 9 * 1024 ** 3, usage: 0.56, swapTotal: 0, swapUsed: 0 },
              disks: [{ mount: '/', total: 100 * 1024 ** 3, used: 92 * 1024 ** 3, free: 8 * 1024 ** 3, usage: 0.92 }],
              net: { txBytes: 0, rxBytes: 0, txRate: 0, rxRate: 0, interfaces: ['eth0'] },
            },
            logs: { journalBytes: 3.4 * 1024 ** 3, varLogBytes: 0, capMb: 1024, capSource: 'default', top: [], lastVacuum: null },
          },
          telemetryAt: Date.now() - 12000, telemetryAge: 12000, logCapMb: null,
        },
        accounts: 2, maxAccounts: 10, seats: 1, full: false,
        botVersions: [{ version: '0.9.0+aaa-arm64', seats: 1 }], botOutdated: false,
        managerDesired: null, managerOutdated: false, managerPending: false, timezonePending: false,
        company: { id: 'org-1', name: 'UI-SMOKE-公司', slug: 'smoke', status: 'active' },
      }]
      ui.render()
      const page = ui.html()
      assert(page.includes('公司信息'), '公司详情页没画出来')
      assert(page.includes('UI-SMOKE-公司'), '标题没画出公司名')
      // 那一格：最吃紧的是盘 92%，写出来的是它，不是三项并排。
      assert(page.includes('盘 / 92%'), `机器负载那一格没画出来：${page.includes('负载') ? '有「负载」但没有数值' : '连「负载」都没有'}`)
      assert(page.includes('成员') && page.includes('订阅'), '成员或订阅那两块没画出来')
    })

    await test('机器详情的「部署的 Bot」：模版版本单独一列，出错的那行也还看得见', async () => {
      /**
       * 这张表原来只说「装的是哪个发布包」。模版版本一度是**塞进「版本 / 错误」那一格**
       * 的——那格出错时画的是 lastError，于是「这台跑的是哪一版模版」恰恰在出错时消失，
       * 而那正是最该看见它的时候。所以单独一列。
       *
       * 没报到过的画「—」，不画 v0：那是「这台席位从来没报过」，多半意味着上面的 bot
       * 进程不在了，和「跑着旧版本」要查的是两件事。
       */
      const ui = await boot(ownerToken)
      const mid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      ui.state.path = `/machines/${mid}`
      ui.state.machineDetail = {
        no: 1,
        machine: {
          id: mid, host: 'http://10.0.0.12:8443', paired: true, pairedAt: Date.now(),
          managerVersion: '0.3.1+abc-arm64', protocol: 1, lastError: null,
          lastHeartbeatAt: Date.now() - 12000, link: 'online', heartbeatAge: 12000,
          timezone: null, currentTimezone: 'Asia/Singapore', arch: 'arm64',
          telemetry: null, telemetryAt: null, telemetryAge: null, logCapMb: null,
        },
        accounts: 2, maxAccounts: 10, seats: 3, full: false,
        botVersions: [{ version: '0.1.10+06f047e-arm64', seats: 3 }], botOutdated: false,
        tplVersions: [{ version: 5, seats: 1 }, { version: 4, seats: 1 }, { version: null, seats: 1 }],
        managerDesired: null, managerOutdated: false, managerPending: false, timezonePending: false,
        company: { id: 'c1', name: 'Acme', slug: 'acme' },
        seatList: [
          { seatId: 'sw-1', botId: 'b1', botName: '我的助手', linuxUser: 'u1', who: 'vzz@x.com', whoName: 'vzz', slot: 0, status: 'ready', botVersion: '0.1.10+06f047e-arm64', tplVersion: 5, tplSyncedAt: Date.now() - 60000, lastError: null, deployedAt: Date.now(), orphan: false },
          { seatId: 'sw-2', botId: 'b2', botName: '回访助手', linuxUser: 'u2', who: 'lee@x.com', whoName: '李四', slot: 1, status: 'error', botVersion: '0.1.10+06f047e-arm64', tplVersion: 4, tplSyncedAt: Date.now() - 7200000, lastError: '端口被占用', deployedAt: Date.now(), orphan: false },
          { seatId: 'sw-3', botId: 'b3', botName: '新来的', linuxUser: 'u3', who: 'new@x.com', whoName: '新人', slot: 2, status: 'ready', botVersion: '0.1.10+06f047e-arm64', tplVersion: null, tplSyncedAt: null, lastError: null, deployedAt: Date.now(), orphan: false },
        ],
      }
      ui.render()
      const html = ui.html()
      assert(html.includes('部署的 Bot'), '席位表没画出来')
      assert(html.includes('>v5<') && html.includes('>v4<'), `模版那一列没画出版本号`)
      // 出错的那一行：错误照常显示，而模版版本**不跟着消失**——这正是分列的理由。
      assert(html.includes('端口被占用'), '出错的那行没显示错误')
      // 错误那串在 title 和正文里各出现一次，取**最后**一次之后的片段：模版那一格排在
      // 它后面，还在，就说明分列真的把它救出来了。
      assert(html.split('端口被占用').pop().includes('>v4<'), '出错的那行把模版版本吃掉了')
      // 版本汇总那一格同理：两个「版本」是两件会各自落后的事。
      assert(html.includes('v5 × 1') && html.includes('还没报到 × 1'), '版本面板没汇总模版版本')
    })

    await test('机器详情：重铺的入口常在，且说得出会往席位里写哪个 Gateway 地址', async () => {
      /**
       * 那颗批量按钮原先挂在 `botOutdated` 上——版本都最新时整颗都不画，于是「版本没错、
       * 只是配置旧了」这一档在界面上没有任何出口。而那正是 Gateway 换了对外地址之后的
       * 样子：席位的 bot.env 是部署那一刻写死的，版本号一个字都没变。
       */
      const ui = await boot(ownerToken)
      const mid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      const detail = (extra) => ({
        no: 1,
        machine: {
          id: mid, host: 'http://10.0.0.12:8443', paired: true, pairedAt: Date.now(),
          managerVersion: '0.3.1', protocol: 2, lastError: null,
          lastHeartbeatAt: Date.now() - 12000, link: 'online', heartbeatAge: 12000,
          timezone: null, currentTimezone: null, arch: 'arm64',
          telemetry: null, telemetryAt: null, telemetryAge: null, logCapMb: null,
        },
        accounts: 1, maxAccounts: 10, seats: 2, full: false,
        botVersions: [{ version: '0.1.10', seats: 2 }], botOutdated: false,
        tplVersions: [{ version: 5, seats: 2 }],
        managerDesired: null, managerOutdated: false, managerPending: false, timezonePending: false,
        company: { id: 'c1', name: 'Acme', slug: 'acme' },
        seatGatewayUrl: 'http://127.0.0.1:3080',
        seatGatewayUrlConfigured: false,
        seatList: [
          { seatId: 'sw-1', botId: 'b1', botName: '我的助手', linuxUser: 'u1', who: 'vzz@x.com', whoName: 'vzz', slot: 0, status: 'ready', botVersion: '0.1.10', tplVersion: 5, tplSyncedAt: Date.now(), lastError: null, deployedAt: Date.now(), accountId: 'acc-1', orphan: false },
          { seatId: 'sw-2', botId: 'b2', botName: null, linuxUser: 'u2', who: 'lee@x.com', whoName: '李四', slot: 1, status: 'ready', botVersion: '0.1.10', tplVersion: 5, tplSyncedAt: Date.now(), lastError: null, deployedAt: Date.now(), accountId: 'acc-2', orphan: true },
        ],
        ...extra,
      })
      ui.state.path = `/machines/${mid}`

      /**
       * 断言认的是**按钮那一段**，不是整页里有没有这几个字：底下那段说明里两个名字
       * 都写着（它讲的正是这颗按钮的两副面孔），拿整页去 includes 会永远为真。
       */
      const bulkBtn = (h) => {
        const i = h.indexOf('data-act="machine-bot-update"')
        return i < 0 ? '' : h.slice(h.lastIndexOf('<button', i), h.indexOf('</button>', i))
      }

      // ① 版本都最新：按钮还在，只是换了一副面孔——「全部重铺」。
      ui.state.machineDetail = detail()
      ui.render()
      let html = ui.html()
      assert(bulkBtn(html), '版本最新时连重铺的入口都没有')
      assert(bulkBtn(html).includes('全部重铺'), `按钮上写的不是重铺：${bulkBtn(html)}`)
      assert(bulkBtn(html).includes('data-mode="reflow"'), '批量按钮没带上「这是重铺不是升级」')

      // ② 有新版本：还是那颗按钮，说的是升级。
      ui.state.machineDetail = detail({ botOutdated: true })
      ui.render()
      html = ui.html()
      assert(bulkBtn(html).includes('全部升级'), `有新版本时按钮上写的不是升级：${bulkBtn(html)}`)
      assert(bulkBtn(html).includes('data-mode="upgrade"'), '按钮没带上「这是升级」')

      // ③ 会往席位里写哪个地址——摆在按钮旁边，没明确配过还要说出来。
      assert(html.includes('席位连的 Gateway'), '没说重铺会写哪个 Gateway 地址')
      assert(html.includes('http://127.0.0.1:3080'), '地址本身没画出来')
      assert(html.includes('没配 GATEWAY_PUBLIC_URL，这是猜的'), '猜出来的地址没有警示')

      // ④ 席位行上的「重新部署」：有主人的才给，孤儿行给的是「清理」。
      const mine = html.slice(html.indexOf('sw-1'), html.indexOf('sw-2'))
      assert(mine.includes('data-act="machine-seat-redeploy"'), '有主人的席位没有重铺入口')
      assert(mine.includes('data-account="acc-1"') && mine.includes('data-bot="b1"'), '重铺按钮没带上是谁的哪一颗')
      const orphan = html.slice(html.indexOf('sw-2'))
      assert(!orphan.includes('data-act="machine-seat-redeploy"'), '没有主人的席位不该给重铺入口')
      assert(orphan.includes('data-act="clean-seat"'), '孤儿席位该给的是清理')

      // ⑤ 没有席位的机器：那颗按钮按下去什么也不会发生，就别画。
      ui.state.machineDetail = detail({ seats: 0, seatList: [], botVersions: [] })
      ui.render()
      assert(!bulkBtn(ui.html()), '一个席位都没有还画着重铺按钮')
    })

    await test('机器管理：菜单在「机器配置」上面，列表和详情画得出，公司侧进不去', async () => {
      // 这一页答的是「平台上挂着哪些机器」，公司详情里那块「运行机器」答的是「这家
      // 有几台」。断言分三层：入口在不在、两张页面画不画得出、以及**没派给公司的机器
      // 有没有列出来**——最后这条正是这一页存在的理由，按公司列永远列不到它们。
      const ui = await boot(ownerToken)
      const nav = ui.html()
      assert(nav.includes('机器管理'), '平台菜单里没有「机器管理」')
      assert(
        nav.indexOf('机器管理') < nav.indexOf('机器配置'),
        '「机器管理」该排在「机器配置」上面：先看哪台机器出事，再谈给它发什么包',
      )
      assert(ui.pathAllowed('/machines') && ui.pathAllowed('/machines/some-id'), '列表或详情被挡在门外')

      const machine = (over) => ({
        no: null,
        machine: {
          id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          host: 'http://10.0.0.12:8443',
          paired: true,
          pairedAt: Date.now(),
          managerVersion: '0.3.1+abc-arm64',
          protocol: 1,
          lastError: null,
          lastHeartbeatAt: Date.now() - 12000,
          link: 'online',
          heartbeatAge: 12000,
          timezone: null,
          currentTimezone: null,
          arch: 'arm64',
          // 机器自报的负载与日志占用。**盘故意画到 92%**：这一页最该一眼看见的就是
          // 一台快写满的机器，而颜色分档（75/90）只有真有个超线的值才验得到。
          telemetry: {
            metrics: {
              uptime: 3 * 86400 + 3600,
              cpu: { cores: 8, usage: 0.23, load1: 1.8 },
              memory: { total: 16 * 1024 ** 3, used: 9 * 1024 ** 3, usage: 0.56, swapTotal: 0, swapUsed: 0 },
              disks: [{ mount: '/', total: 100 * 1024 ** 3, used: 92 * 1024 ** 3, free: 8 * 1024 ** 3, usage: 0.92 }],
              net: { txBytes: 42 * 1024 ** 3, rxBytes: 10 * 1024 ** 3, txRate: 1.2 * 1024 ** 2, rxRate: 2048, interfaces: ['eth0'] },
            },
            logs: {
              journalBytes: 3.4 * 1024 ** 3,
              varLogBytes: 3.6 * 1024 ** 3,
              capMb: 1024,
              capSource: 'default',
              top: [{ path: '/var/log/syslog', size: 120 * 1024 ** 2 }],
              lastVacuum: { at: Date.now() - 3600_000, before: 4 * 1024 ** 3, after: 600 * 1024 ** 2, freed: 3.4 * 1024 ** 3, keepMb: 614, error: '' },
            },
          },
          telemetryAt: Date.now() - 12000,
          telemetryAge: 12000,
          logCapMb: null,
          ...(over || {}),
        },
        accounts: 3,
        maxAccounts: 10,
        seats: 2,
        full: false,
        botVersions: [{ version: '0.9.0+aaa-arm64', seats: 2 }],
        botOutdated: false,
        managerDesired: null,
        managerOutdated: false,
        managerPending: false,
        timezonePending: false,
        company: { id: 'c1', name: 'UI-SMOKE-公司', slug: 'smoke', status: 'active' },
      })
      const orphan = {
        ...machine({
          id: 'ffffffff-0000-4000-8000-000000000000',
          host: null,
          paired: false,
          link: 'unpaired',
          lastHeartbeatAt: null,
          heartbeatAge: null,
          managerVersion: null,
          // 没配对的机器什么都不报。
          telemetry: null,
          telemetryAt: null,
          telemetryAge: null,
        }),
        company: null,
      }

      ui.state.path = '/machines'
      ui.state.allMachines = [machine(), orphan]
      ui.state.machineTotals = { machines: 2, paired: 1, online: 1, accounts: 3, max: 10, seats: 2 }
      ui.render()
      const list = ui.html()
      assert(list.includes('UI-SMOKE-公司'), '列表没画出归属公司')
      assert(list.includes('未分配'), '没派给公司的机器没标出来——它恰恰是这一页要看见的那种')
      assert(list.includes('data-href="/machines/ffffffff-0000-4000-8000-000000000000"'), '行点不进详情')
      // **列表里不再有「负载」那一列**（e116054：八列在常见窗口下会把「最近心跳」挤出
      // 屏幕，砍掉负载列之后才放得下）。这里原来钉的三条都是那一格的，跟着一起撤——
      // 留着的话就是三条永远红的断言，钉的是一个已经不存在的控件。刻度分档改由下面
      // 详情页那一段钉（meter / pctText 只剩它在用了）。

      ui.state.path = '/machines/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      ui.state.machineDetail = {
        ...machine(),
        seatList: [
          {
            accountId: 'a1',
            who: 'zhang@smoke.test',
            whoName: '张三',
            botId: 'b1',
            botName: 'UI-SMOKE-助理',
            seatId: 'smoke-zhang-b1',
            linuxUser: 'sw_a1',
            slot: 3,
            status: 'ready',
            botVersion: '0.9.0+aaa-arm64',
            lastError: null,
            deployedAt: Date.now(),
          },
        ],
        companies: [{ id: 'c1', name: 'UI-SMOKE-公司', slug: 'smoke' }],
      }
      ui.render()
      const detail = ui.html()
      assert(detail.includes('smoke-zhang-b1'), '详情页没列出席位')
      // 「席位数」和「席位清单」共用一个键的话，这里会画出一串 [object Object]，
      // 而「这台机器上还有没有席位」也会跟着判错（空数组是真值）。
      assert(!detail.includes('[object Object]'), '有字段被当成对象直接拼进 HTML 了')
      // Bot 名要用接口给的那个。回落到 state.bots 的话，直接打开这个地址时整列是 uuid
      // ——而 state.bots 只有逛过别的页面才会有内容。
      assert(detail.includes('UI-SMOKE-助理'), '列表没用接口给的 Bot 名')
      // 出错的那个要比正常的显眼：这一页就是用来找坏掉那个的。
      assert(/tag-accent">运行中/.test(detail) === false, '正常的不该占着最扎眼的那档标签')
      assert(detail.includes('tag-accent-2">运行中'), 'ready 该是安静的那一档')
      // ── 负载与日志：这一页新加的两块 ────────────────────────────────
      assert(detail.includes('机器负载'), '详情页没有负载那块')
      assert(detail.includes('8 核') && detail.includes('23%'), `CPU 那行不对：${detail.slice(detail.indexOf('机器负载'), detail.indexOf('机器负载') + 600)}`)
      assert(detail.includes('92%'), '磁盘占用没画出来')
      // 92% 的盘要进最响的那一档颜色——这几根条存在的意义就是在机器写满之前看见它。
      // （列表那一列砍掉之后，这里是唯一还钉着分档的地方。）
      assert(/satu-gauge" data-level="hot"/.test(detail), '92% 的盘没进最响那一档，红线就白划了')
      assert(detail.includes('MB/s'), '出网速率没画出来')
      // 数是机器自报的、隔一轮心跳才来一次，所以必须先说清楚它有多新——不然一台失联
      // 机器上的「CPU 5%」看着和好机器一模一样。
      assert(/采样于/.test(detail), '没说这份数是什么时候采的')
      assert(detail.includes('日志占用'), '详情页没有日志那块')
      assert(detail.includes('data-form="machine-log-cap"'), '改日志上限的表单没接上')
      assert(detail.includes('data-act="machine-logs-vacuum"'), '手动清理的按钮没接上')
      // 超过上限要写出来：这一格是「管家会自己清」还是「它不清」，处置完全不同。
      assert(detail.includes('超过上限'), '3.4 GB 的 journal 压着 1024 MB 的上限，没说它超了')
      // 算不出百分比时**只说一遍**。原先条子和数值格各写一句「取样中」，同一行里
      // 出现两遍；空心虚线的槽负责占位，话由数值格去说。
      // 每次都从 machine() 现造一份并深拷一层：下面几段各改各的那一格，共用同一个
      // 对象的话，前一段的改动会跟着漏进后一段，断言就成了看运气。
      const variant = (tweak) => {
        const card = { ...machine(), seatList: [], companies: [] }
        card.machine = JSON.parse(JSON.stringify(card.machine))
        tweak(card.machine)
        return card
      }
      const asIs = ui.state.machineDetail

      ui.state.machineDetail = variant((m) => {
        m.telemetry.metrics.cpu.usage = null
      })
      ui.render()
      const half = ui.html()
      assert((half.match(/取样中/g) || []).length === 1, `「取样中」出现了 ${(half.match(/取样中/g) || []).length} 次，该只有一次`)
      assert(half.includes('data-level="none"'), '算不出来的那一格该画空心虚线槽，不能画成实心的 0%')

      // 上限为 0（这台机器不自动清）同样没有百分比可算，但机器一直在正常上报——
      // 写成「取样中」会让人跑去查一件根本没坏的事。
      ui.state.machineDetail = variant((m) => {
        m.telemetry.logs.capMb = 0
        m.logCapMb = 0
      })
      ui.render()
      const uncapped = ui.html()
      assert(uncapped.includes('不限'), 'journal 那行没写「不限」')
      assert(!uncapped.includes('取样中'), '上限为 0 被说成了「取样中」')

      // 机器上用 SATUWORK_LOG_CAP_MB 钉死时，期望值永远追不上实际值、pending 恒为真
      // ——那句「这里改不动它」必须排在前面，否则它恰好在唯一需要它的场景下画不出来。
      ui.state.machineDetail = variant((m) => {
        m.telemetry.logs.capSource = 'env'
        m.telemetry.logs.capMb = 2048
        m.logCapMb = 900
      })
      ui.render()
      const env = ui.html()
      assert(env.includes('SATUWORK_LOG_CAP_MB'), '本机钉死那句话没画出来')
      assert(!env.includes('已下指令，机器现在用的是'), '本机钉死时不该一直说「等机器认」')

      // ── 负载那块的两档：实时 / 日 ──────────────────────────────────
      ui.state.machineDetail = asIs
      ui.render()
      const live = ui.html()
      assert(live.includes('data-act="machine-load-tab"'), '负载那块没有档位切换')
      assert(!/data-tab="month"/.test(live), '月那一档已经取消了，不该还画着')

      // 「日」这一档吃的是另一条接口（按分钟归的档），所以要连数据一起摆进去。
      // key 对不上时界面只会写「载入中」——那条比对本身也顺带验到了。
      const today = new Date()
      const p2 = (n) => String(n).padStart(2, '0')
      const dayKey = `${today.getFullYear()}-${p2(today.getMonth() + 1)}-${p2(today.getDate())}`
      const at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 30).getTime()
      ui.state.machineLoadTab = 'day'
      ui.state.machineLoadDate = dayKey
      ui.state.machineLoadMinutes = {
        key: `${asIs.machine.id}|day|${dayKey}`,
        retentionMs: 30 * 24 * 3600_000,
        minutes: [
          { minuteStart: at, samples: 2, cpuAvg: 0.2, cpuMax: 0.85, memAvg: 0.5, memMax: 0.6, diskAvg: 0.9, diskMax: 0.92, txBytes: 1024 * 1024, rxBytes: 2048 },
          { minuteStart: at + 60_000, samples: 2, cpuAvg: 0.1, cpuMax: 0.2, memAvg: 0.5, memMax: 0.5, diskAvg: 0.9, diskMax: 0.9, txBytes: 2048, rxBytes: 1024 },
        ],
      }
      ui.render()
      const day = ui.html()
      assert(day.includes('satu-bars'), '日视图没画出柱图')
      assert(day.includes('data-act="machine-load-date"'), '日视图没有日期选择器')
      // 峰值必须单独说出来：均值 20%，而那一分钟真冲到过 85%——人要找的就是它。
      assert(day.includes('85%'), `峰值没画出来：${day.slice(day.indexOf('satu-bars') - 400, day.indexOf('satu-bars'))}`)
      // 有数据的格子远少于总格数，这句话要如实说，不能把空档说成 0。
      // 09:30 和 09:31 落在**同一个 10 分钟格**里，所以是 1 格不是 2——这正是「库里按
      // 分钟存、画的时候并成 10 分钟」那句话的意思。
      assert(/1 \/ 144 格有数据/.test(day), `没说清多少格有数据：${day.slice(day.indexOf('出网合计') - 100, day.indexOf('出网合计') + 200)}`)

      // 超出保留期的那一天：要说「已经清掉了」，不是含混地空一片让人以为机器没开。
      const old2 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 60)
      const oldKey = `${old2.getFullYear()}-${p2(old2.getMonth() + 1)}-${p2(old2.getDate())}`
      ui.state.machineLoadDate = oldKey
      ui.state.machineLoadMinutes = { key: `${asIs.machine.id}|day|${oldKey}`, retentionMs: 30 * 24 * 3600_000, minutes: [] }
      ui.render()
      assert(ui.html().includes('保留期'), '超出保留期的那天没说清是被清掉了')

      ui.state.machineLoadTab = 'live'
      ui.state.machineLoadDate = ''
      ui.state.machineLoadMinutes = null
      ui.render()
      assert(detail.includes('data-form="machine-capacity"'), '改容量的表单没接上')
      assert(detail.includes('data-form="machine-company"'), '改归属的表单没接上')
      // 上面有 Bot 也删得掉（登记跟着一起没），所以按钮**不该**是禁的——以前禁掉的
      // 结果是人对着一颗灰按钮猜为什么。代价改由确认框来说。
      assert(!/data-act="machine-remove"[^>]*disabled/.test(detail), '上面有 Bot 不该把移除按钮禁掉')
      assert(detail.includes('Bot 登记会一起抹掉'), '没告诉人这些 Bot 的登记会跟着一起没')
      // scope 决定接口前缀。漏了它，平台页上的每个动作都会打到公司那条路上去，
      // 而那条路要 orgId——没归属的机器上一个动作都做不了。
      assert(detail.includes('data-scope="platform"'), '动作没标 scope，会打到公司那条接口上')

      // 公司管理员没有这一页：机器是平台的事。
      const admin = await boot(adminToken)
      assert(!admin.pathAllowed('/machines'), '公司管理员不该进得去机器管理')
    })

    await test('审计只留总结，并把日期、员工、Bot 筛选下推给接口', async () => {
      const requested = []
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path, init) => {
          requested.push(path)
          return fetch(gwBase + path, init)
        },
      })
      await ui.boot()
      requested.length = 0
      ui.state.auditAccountId = 'employee-1'
      ui.state.auditBotId = 'bot-1'
      ui.state.auditFrom = '2026-08-01'
      ui.state.auditTo = '2026-08-31'
      await ui.loadConversationAudits()
      const path = requested.find((x) => x.includes('/conversation-audits?')) || ''
      assert(path.includes('accountId=employee-1'), `员工没进查询：${path}`)
      assert(path.includes('botId=bot-1'), `Bot 没进查询：${path}`)
      assert(/[?&]from=\d+/.test(path) && /[?&]to=\d+/.test(path), `日期没进查询：${path}`)

      ui.state.path = '/audit'
      ui.state.auditFilterOptions = {
        accounts: [{ id: 'employee-1', name: 'UI-SMOKE-甲' }],
        bots: [{ id: 'bot-1', name: 'UI-SMOKE-Bot' }],
      }
      ui.state.auditItems = [{
        id: 'summary-1', taskSummary: 'UI-SMOKE-审计总结', accountId: 'employee-1', accountName: 'UI-SMOKE-甲',
        botId: 'bot-1', botName: 'UI-SMOKE-Bot', outcome: 'completed', modelScore: 91, endedAt: Date.now(),
      }]
      ui.render()
      const html = ui.html()
      assert(html.includes('UI-SMOKE-审计总结'), '总结没有画出来')
      assert(html.includes('id="audit-filter-form"') && html.includes('name="botId"'), '筛选表单缺员工或 Bot')
      assert(html.includes('type="date"') && html.includes('2026-08-01') && html.includes('2026-08-31'), '日期筛选没保留')
      assert(!html.includes('data-tab="chats"') && !html.includes('data-tab="events"'), '对话或操作记录页签还在')
      assert(!html.includes('对话索引') && !html.includes('管理员操作记录'), '审计页还在宣传已取消的内容')
      assert(ui.pathAllowed('/audit/summary/summary-1'), '总结详情应该仍可打开')
      assert(!ui.pathAllowed('/audit/session-1'), '旧的原始对话详情不该再能打开')
    })

    await test('机器配置：桌面端本地 Bot 一页，按平台列出生效版本，新增走 local-bot 那条路', async () => {
      const requested = []
      const releases = {
        releases: [
          { version: '0.1.13+aaaaaaa-darwin-arm64', size: 1, sha256: 'a', createdAt: 2 },
          { version: '0.1.12+bbbbbbb-darwin-arm64', size: 1, sha256: 'b', createdAt: 1 },
          { version: '0.1.12+bbbbbbb-windows-x64', size: 1, sha256: 'c', createdAt: 1 },
        ],
        latestByTarget: { 'darwin-arm64': '0.1.13+aaaaaaa-darwin-arm64', 'windows-x64': '0.1.12+bbbbbbb-windows-x64' },
      }
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: 'ui-smoke-token',
        fetchImpl: async (path, init) => {
          requested.push(`${(init && init.method) || 'GET'} ${path}`)
          const body = path.startsWith('/platform/local-bot-releases') && (!init || !init.method || init.method === 'GET')
            ? releases
            : path.startsWith('/platform/local-bot-releases') ? { release: { version: 'x' } } : { releases: [] }
          return { ok: true, status: 200, text: async () => JSON.stringify(body) }
        },
      })
      ui.state.me = { account: { id: 'o', role: 'owner', name: 'O' }, settings: {} }
      ui.state.path = '/releases'
      await ui.loadPage()
      assert(requested.some((x) => x === 'GET /platform/local-bot-releases'), `没取本地 Bot 的发布：${requested.join(', ')}`)
      ui.state.machineTab = 'local-bot'
      ui.render()
      const html = ui.html()
      assert(html.includes('data-tab="local-bot"'), '没有桌面端本地 Bot 那个 tab')
      assert(html.includes('Windows · x64') && html.includes('0.1.12+bbbbbbb-windows-x64'), '没按平台列出生效版本')
      assert(html.includes('还没有这个平台的包'), '缺包的平台该如实说没有')
      // 每个平台各有一个「最新」：darwin 那条老版本不该被标成最新。
      const oldRow = html.slice(html.indexOf('0.1.12+bbbbbbb-darwin-arm64'), html.indexOf('0.1.12+bbbbbbb-darwin-arm64') + 200)
      assert(!oldRow.includes('tag-accent'), 'darwin 的老版本也被标成了最新')
      assert(html.includes('data-form="add-release" data-kind="local-bot"'), '新增表单没有按 local-bot 走')
    })

    await test('审计总结翻页：游标跟着请求走，换筛选回到第一页', async () => {
      const requested = []
      let page = 0
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: 'ui-smoke-token',
        fetchImpl: async (path) => {
          requested.push(path)
          page += 1
          const body = { filters: { accounts: [], bots: [] }, items: [{ id: `p${page}`, taskSummary: `第${page}批`, outcome: 'completed', endedAt: 1 }], hasMore: page < 2, nextCursor: page < 2 ? `100:p${page}` : null }
          return { ok: true, status: 200, text: async () => JSON.stringify(body) }
        },
      })
      ui.state.me = { account: { id: 'a', role: 'admin', companyId: 'c' }, company: { id: 'c' }, settings: {} }
      ui.state.path = '/audit'
      await ui.loadConversationAudits(true)
      ui.render()
      assert(/data-act="audit-next"(?![^>]*disabled)/.test(ui.html()), '有下一页却点不了')
      assert(requested[0].includes('limit=20') && !requested[0].includes('cursor='), `第一页不该带游标：${requested[0]}`)
      ui.state.auditCursors.push(ui.state.auditNextCursor)
      await ui.loadConversationAudits()
      assert(requested[1].includes('cursor=100%3Ap1'), `第二页没带上一页给的游标：${requested[1]}`)
      ui.render()
      assert(ui.html().includes('第 2 页') && !/data-act="audit-next"(?![^>]*disabled)/.test(ui.html()), '最后一页还能点下一页')
      await ui.loadConversationAudits(true)
      assert(!requested[2].includes('cursor='), `换了筛选还在接着翻旧游标：${requested[2]}`)

      /**
       * 从详情页回来留在原来那一页；从别的页（侧栏）进来回到第一页——上次停在第 2 页的那串
       * 游标是按当时的结果算的。
       */
      ui.state.auditCursors = [null, '100:p1']
      ui.state.path = '/audit/summary/p1'
      await ui.loadPage()
      ui.state.path = '/audit'
      await ui.loadPage()
      assert(ui.state.auditCursors.length === 2, `从详情页回来被弹回了第一页：${JSON.stringify(ui.state.auditCursors)}`)
      ui.state.path = '/usage'
      await ui.loadPage()
      ui.state.path = '/audit'
      await ui.loadPage()
      assert(ui.state.auditCursors.length === 1, `从别的页进来还停在旧的第 2 页：${JSON.stringify(ui.state.auditCursors)}`)
    })

    await test('审计详情：评分明细逐项写出得分、满分和原因', async () => {
      const ui = loadApp({ appPath, base: gwBase, token: 'ui-smoke-token', fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) })
      ui.state.me = { account: { id: 'a', role: 'admin', companyId: 'c' }, company: { id: 'c' }, settings: {} }
      ui.state.path = '/audit/summary/i1'
      ui.state.auditItemDetail = {
        batch: null,
        item: {
          id: 'i1', taskSummary: '发报价', outcome: 'partial', modelScore: 70, timeline: [], evidence: [], riskFlags: [],
          scoreBreakdown: { completion: 28, evidence: 22, instructionFollowing: 9, efficiency: 6, communication: 5 },
          scoreReasons: { completion: 'UI-SMOKE-漏了抄送财务', instructionFollowing: 'UI-SMOKE-没按要求抄送' },
        },
      }
      ui.render()
      const html = ui.html()
      assert(html.includes('完成度') && html.includes('28') && html.includes('/ 40'), '分项没画成「得分 / 满分」')
      assert(html.includes('UI-SMOKE-漏了抄送财务') && html.includes('UI-SMOKE-没按要求抄送'), '评分原因没画出来')
      assert(html.includes('没有写原因'), '缺原因的那几项该如实说没有，不该空着')
      assert(!html.includes('completion: 28'), '还在画旧的「键: 分数」那一串')

      // 条目自己带了满分（评分规则改过）：按它画，不按前端那份旧规则。
      ui.state.auditItemDetail.item.scoreMax = { completion: 50, evidence: 20, instructionFollowing: 10, efficiency: 10, communication: 10 }
      ui.render()
      assert(ui.html().includes('/ 50') && !ui.html().includes('/ 40'), '满分没按条目自带的画')
    })

    await test('建连失败（503）之后闩要放开，聊天还能重连', async () => {
      // chatAbort / chatStreamId 这对「当前流」的闩，建连失败时一度不放。
      // ensureChatSession 和 startChatStream 都拿它判断「已经有流在跑」，于是实例
      // 还没起来那一次 503 之后，聊天再也不会重连，要刷新整页才回得来。
      let hits = 0
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/events')) {
            hits += 1
            return { ok: false, status: 503, text: async () => '实例还没上线' }
          }
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      await ui.startChatStream('s-latch')
      assert(hits === 1, `第一次该打一次，实际 ${hits}`)
      await ui.startChatStream('s-latch')
      assert(hits === 2, `503 之后闩没放开，聊天不会再重连——只打了 ${hits} 次`)
      ui.stopChatStream()
    })

    await test('短命连接不清退避档位，否则会无限重连', async () => {
      // 判据是「这次连接活了多久」，不是「有没有连上」。bot 在崩溃重启循环里每次都
      // 给 200 然后立刻断；按「连上就清零」算的话，退避永远回到 500ms，重连停不下来。
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        // **init 要原样带上**：不带的话 /me 少了 authorization，boot 会掉进登录页，
        // 而这一条要验的恰恰是「对话页上那条横幅画出来没有」。
        fetchImpl: async (path, init) => {
          if (path.includes('/events')) {
            const sse = fakeSse()
            sse.close() // 接受连接，立刻收流
            return sse.response
          }
          return fetch(gwBase + path, init)
        },
      })
      await ui.boot()
      // 认输那句话要真的上屏，所以这一屏得是对话页（横幅只由 chatPage() 拼），
      // 而且断掉的得**正是人在看的那条会话**——后台那几条流断了不该占用这条横幅
      // （见下一条）。
      ui.state.path = '/chat'
      ui.state.chatSessionId = 's-backoff'
      try {
        // 从最后一档进去：连接活得太短就不该清零，所以这一次就该判定「断开」。
        await ui.startChatStream('s-backoff', ui.CHAT_RETRY_MAX)
        assert(
          ui.state.runtimeError === '连接断开',
          `短命连接把退避档位清零了，会一直 500ms 重连一次；runtimeError=${JSON.stringify(ui.state.runtimeError)}`,
        )
        /**
         * **写进 state 不等于人看得见。**
         *
         * 那句话和旁边那颗「重新连接」按钮画在顶上那条横幅里，而横幅只在 chatPage()
         * 里拼一次——paintChat 只重画消息流和输入区，横幅一个字都不会变。而认输这一刻
         * 恰恰是「再没有别的东西会触发重绘」：流死了、事件不会再来。于是屏幕上什么都
         * 没有：认输了、没人再重连、也没有那颗能救回来的按钮。
         */
        /**
         * **认输之后不许撒手。**
         *
         * 线上抓到的那次：席位 22:23:25 重启、22:23:26 就在听了，浏览器却过了 5 分钟才
         * 连上——标签页在后台，浏览器把定时器节流甚至冻住，退避链醒来时档位早就到头，
         * 于是「认输」，从此再没有任何东西去碰它。所以认输的同时要排一根慢速长跑。
         */
        assert(ui.idleTimers.size > 0, '认输之后一根重试都没排——席位回来了也没人去接')
        const html = ui.html()
        assert(html.includes('连接断开'), '认输了却没画到屏幕上——只写了 state，横幅没重绘')
        assert(
          html.includes('data-act="chat-reconnect"'),
          '没有「重新连接」按钮：认输之后没有任何东西会再去重连，人只能刷新整页',
        )
      } finally {
        // 清零的那个版本会留下一串 setTimeout 自我续命，套件就不退出了。
        ui.stopChatStream()
      }
    })

    await test('会话还没到手时发的那一条：挂着，接上之后自动补发（只发一次）', async () => {
      /**
       * 席位换版必然踩中这一刻：换了进程之后客户端要重新拿一次会话，中间隔着一个往返，
       * 而人正好在这时候按发送。以前退回给他一句「接上再按一次」——等于把重试的活派给
       * 了人，而这正是「升级之后第一条消息发不出去」的由来。
       */
      let ready = false
      let posted = []
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path, init) => {
          if (path.includes('/events')) return sse.response
          if (path.includes('/bots/bot-h/session')) {
            // 头一下还没接上；ready 之后才给会话。
            if (!ready) return { ok: false, status: 503, text: async () => '实例还没上线' }
            return { ok: true, status: 200, text: async () => JSON.stringify({ sessionId: 's-h' }) }
          }
          if (path.includes('/messages') && init && init.method === 'POST') {
            posted.push(JSON.parse(init.body).text)
            return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
          }
          return fetch(gwBase + path, init)
        },
      })
      await ui.boot()
      ui.state.path = '/chat'
      ui.state.chatBotId = 'bot-h'
      ui.state.chatSessionId = ''
      ui.state.chatDraft = '换版那一刻打的这句'
      try {
        await ui.sendChat()
        assert(posted.length === 0, `会话都没有就发出去了：${JSON.stringify(posted)}`)
        assert(ui.state.chatDraft === '换版那一刻打的这句', '草稿被吞了——人得重打一遍')
        assert(String(ui.state.error || '').includes('自动发出去'), `没告诉人它挂着：${ui.state.error}`)

        // 席位回来了：会话一到手，那条挂着的就该自己出去。
        ready = true
        await ui.ensureChatSession('bot-h')
        for (let i = 0; i < 200 && posted.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
        assert(posted.length === 1, `接上之后没有自动补发（发了 ${posted.length} 条）`)
        assert(posted[0] === '换版那一刻打的这句', `补发的内容不对：${posted[0]}`)
        assert(!ui.state.chatDraft, `补发之后草稿还留着，人会以为没发出去：${JSON.stringify(ui.state.chatDraft)}`)

        // 再拿一次会话不该把同一条又发一遍——标记是一次性的。
        // 负向断言要等够久：50ms 里没发不等于不会发，补发是异步排上的。
        await ui.ensureChatSession('bot-h')
        await new Promise((r) => setTimeout(r, 300))
        assert(posted.length === 1, `同一条被补发了 ${posted.length} 次`)
      } finally {
        sse.close()
        ui.stopChatStream()
      }
    })

    await test('挂上之后人切走了：切回来也不许突然把它发出去', async () => {
      /**
       * 草稿是按 Bot 收的（chatDrafts），人挂上之后切走再切回来，那条草稿会原样回来——
       * 标记要是还留着，这一刻就会**在人没按任何键的情况下**把它发出去。他当初按发送
       * 是冲着「现在就发」，中间去别处转了一圈回来，那个意图早就不作数了。
       *
       * 切走那一下就作废（ensureChatSession 换 Bot 的那一支）。
       */
      const sse = fakeSse()
      const posted = []
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path, init) => {
          if (path.includes('/events')) return sse.response
          if (path.includes('/session')) return { ok: true, status: 200, text: async () => JSON.stringify({ sessionId: 's-x' }) }
          if (path.includes('/messages') && init && init.method === 'POST') {
            posted.push(JSON.parse(init.body).text)
            return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
          }
          return fetch(gwBase + path, init)
        },
      })
      await ui.boot()
      ui.state.path = '/chat'
      ui.state.chatBotId = 'bot-one'
      ui.state.chatSessionId = ''
      ui.state.chatDraft = '这句是写给 bot-one 的'
      try {
        await ui.sendChat()
        assert(posted.length === 0, '前置没成立')
        assert(ui.state.chatDraft === '这句是写给 bot-one 的', '前置没成立：草稿该留着')

        // 人切到别的 Bot 去了……（负向断言：等够 300ms，异步补发要是会发，这时早发了）
        await ui.ensureChatSession('bot-two')
        await new Promise((r) => setTimeout(r, 300))
        assert(posted.length === 0, `挂着的那条被发进了另一个 Bot 的对话：${JSON.stringify(posted)}`)

        // ……又切了回来。草稿原样回来了，但那次「按发送」的意图早就不作数了。
        await ui.ensureChatSession('bot-one')
        await new Promise((r) => setTimeout(r, 300))
        assert(
          posted.length === 0,
          `切回来时把它自动发了出去，而人一个键都没按：${JSON.stringify(posted)}`,
        )
        assert(ui.state.chatDraft === '这句是写给 bot-one 的', '草稿该原样留着，等人自己决定发不发')
      } finally {
        sse.close()
        ui.stopChatStream()
      }
    })

    await test('bot 停机超过五分钟：会话那条链认输之后也要接着慢慢试', async () => {
      /**
       * 「bot 停机」最常见的那一种，恰恰是页面**还没拿到会话**的时候：没有会话就开不出
       * 流，流那根慢速长跑也就永远排不上。会话这条链原先认输之后是真的停手——于是页面
       * 停在「实例还没接上」上，席位回来了也没人去接，只能等人按发送、切回标签页或者
       * 刷新。这一条钉的是「认输的是那串急脾气的重试，不是这件事本身」。
       */
      let hits = 0
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path, init) => {
          if (path.includes('/bots/bot-down/session')) {
            hits += 1
            return { ok: false, status: 503, text: async () => '实例还没上线' }
          }
          return fetch(gwBase + path, init)
        },
      })
      await ui.boot()
      ui.state.path = '/chat'
      ui.state.chatBotId = 'bot-down'
      ui.state.chatSessionId = ''
      try {
        // 直接从最后一档进去：这一条要验的是「认输那一刻做了什么」，不是等它退避五分钟。
        ui.retryChatSession('bot-down', ui.SESSION_RETRY_MAX)
        assert(
          ui.idleTimers.has('session:bot-down'),
          '会话拿不到、认输之后一根重试都没排——bot 回来了这一页也接不上，只能刷新',
        )
        assert(ui.state.runtimeError, '认输了总得把话摆出来')
      } finally {
        ui.stopChatStream()
        ui.idleTimers.forEach((t) => clearTimeout(t))
        ui.idleTimers.clear()
      }
    })

    await test('席位换了一个进程：认出来，整条会话重来，而不是拿旧游标接着看', async () => {
      /**
       * 换版就是把 bot 换一个进程，而浏览器这头只看得见「流断了」。不认这件事的话，它
       * 会拿换版前的游标续传，并接着用旧进程攒下来的状态：那一轮「正在跑」早就随进程
       * 一起没了（日志里连 turn/end 都没写成），排队的 dock、目录里的工具也都可能变了。
       *
       * 席位每条流的第一帧会说一句自己是谁（runtime/hello）——身份变了就整条重来。
       */
      let sessions = 0
      const streams = []
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path, init) => {
          if (path.includes('/events')) {
            const sse = fakeSse()
            streams.push(sse)
            return sse.response
          }
          if (path.includes('/bots/bot-r/session')) {
            sessions += 1
            return { ok: true, status: 200, text: async () => JSON.stringify({ sessionId: 's-r' }) }
          }
          return fetch(gwBase + path, init)
        },
      })
      await ui.boot()
      ui.state.path = '/chat'
      ui.state.chatBotId = 'bot-r'
      await ui.ensureChatSession('bot-r')
      for (let i = 0; i < 100 && !streams.length; i++) await new Promise((r) => setTimeout(r, 10))
      assert(streams.length === 1, `前置没成立：该有一条流，实际 ${streams.length}`)

      // 头一次自报家门：认识一下，什么都不该发生。
      streams[0].push({ type: 'runtime/hello', instanceId: 'seat-1', startedAt: 1 })
      streams[0].push({ seq: 7, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '换版前' }] } } })
      for (let i = 0; i < 100 && ui.botStreamOf('bot-r').events.length < 1; i++) await new Promise((r) => setTimeout(r, 10))
      assert(ui.botStreamOf('bot-r').instanceId === 'seat-1', '第一帧的身份没记下来')
      assert(sessions === 1, `头一次连上不该重新拿会话（拿了 ${sessions} 次）`)

      // 席位换版了：新进程，新身份。
      const before = sessions
      streams[0].push({ type: 'runtime/hello', instanceId: 'seat-2', startedAt: 2 })
      for (let i = 0; i < 200 && sessions === before; i++) await new Promise((r) => setTimeout(r, 10))
      assert(sessions > before, '席位换了进程却没重新拿一次会话——界面会停在换版前那一刻')
      assert(
        ui.botStreamOf('bot-r').events.length === 0,
        `换版前那些事件没作废（还剩 ${ui.botStreamOf('bot-r').events.length} 条），界面会拿旧游标接着看`,
      )
      assert(ui.botStreamOf('bot-r').instanceId === 'seat-2', '新身份没记下来，下一条流会被当成又一次重启')
      for (const s of streams) s.close()
      ui.stopChatStream()
    })

    await test('半死的流：连接没断、字节也不来——三个心跳的静默就掐掉重连', async () => {
      /**
       * 换版把席位杀掉的那一刻，中间哪一跳要是把「断」吞掉（反代的 pipe 没收尾、网络
       * 半开），浏览器手上这条流就成了「看着还开着、永远等不来下一个字节」。而重连那
       * 一整套——退避、慢速长跑、发消息前的 revive、切回前台——判据全是 row.ac 在不
       * 在：半死的流 ac 还在，谁都以为它好着，没有任何东西会去碰它。这正是「回答其实
       * 出了、界面上看不见、刷新才好」修了几轮都没除根的那一种：每一轮修的都是「断了
       * 之后接不回来」，而这一种压根没有断。判据只能是字节本身：bot 每 15 秒一条
       * `: ping`，三个心跳没等到就当死的拆掉重连（见 chat.js 的 sweepSilentStreams）。
       */
      const streams = []
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path, init) => {
          if (path.includes('/events')) {
            const sse = fakeSse()
            streams.push(sse)
            return sse.response
          }
          if (path.includes('/bots/bot-mute/session'))
            return { ok: true, status: 200, text: async () => JSON.stringify({ sessionId: 's-mute' }) }
          return fetch(gwBase + path, init)
        },
      })
      await ui.boot()
      ui.state.path = '/chat'
      ui.state.chatBotId = 'bot-mute'
      await ui.ensureChatSession('bot-mute')
      for (let i = 0; i < 100 && !streams.length; i++) await new Promise((r) => setTimeout(r, 10))
      assert(streams.length === 1, `前置没成立：该有一条流，实际 ${streams.length}`)
      try {
        streams[0].push({ type: 'runtime/hello', instanceId: 'seat-mute', startedAt: 1 })
        streams[0].push({ type: 'replay/done', live: false })
        for (let i = 0; i < 100 && !ui.streamPulse.size; i++) await new Promise((r) => setTimeout(r, 10))
        assert(ui.streamPulse.size === 1, '收到字节却没记脉搏——看门狗从一开始就是瞎的')

        // 刚有过字节：不许误伤，否则好好的流会被半分钟重连一次。
        ui.sweepSilentStreams(Date.now())
        assert(streams.length === 1, '脉搏还新鲜就被掐了')

        // 席位死了而「断」没传下来：流还开着，字节再也不来。
        ui.sweepSilentStreams(Date.now() + ui.STREAM_SILENT_MS + 1000)
        for (let i = 0; i < 200 && streams.length < 2; i++) await new Promise((r) => setTimeout(r, 10))
        assert(streams.length === 2, '静默这么久没人管——半死的流就是那句永远的「正在思考」，只能刷新')
        assert(ui.botStreamOf('bot-mute').ac, '重连之后这一行没有活的 ac，后面谁也认不回它')

        // 新流还一个字节都没吐过：不归这只看门狗管（那是重放看门狗的地界），不许连环掐。
        ui.sweepSilentStreams(Date.now() + ui.STREAM_SILENT_MS * 3)
        await new Promise((r) => setTimeout(r, 30))
        assert(streams.length === 2, '还没开口的新流也被掐了——建连慢一点就会被连环重连')
      } finally {
        for (const s of streams) s.close()
        ui.stopChatStream()
      }
    })

    await test('后台那几条流断了，不许占用正在看的那条对话的横幅', async () => {
      /**
       * 切过 Bot 之后手上会留着前几条对话流，任何一条断掉都会走到认输那一
       * 支。它要是把「连接断开」摆到横幅上，说的却是另一个 Bot 的事：屏幕上这条对话
       * 好好的，人却被告知断了，点「重新连接」重连的还是另一条流。更实在的是那一下
       * 会**整页重绘**——正在打字的人当场丢焦点，起因却是他没在看的一个 Bot。
       */
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path, init) => {
          if (path.includes('/events')) {
            const sse = fakeSse()
            sse.close()
            return sse.response
          }
          return fetch(gwBase + path, init)
        },
      })
      await ui.boot()
      ui.state.path = '/chat'
      // 人正看着 s-front，断的是名单上另一个 Bot 的那条 s-bg。
      ui.state.chatSessionId = 's-front'
      ui.botStreamOf('bot-bg').sessionId = 's-bg'
      try {
        await ui.startChatStream('s-bg', ui.CHAT_RETRY_MAX, 'bot-bg')
        assert(
          !ui.state.runtimeError,
          `后台流断了却给当前这条对话扣了一句话：${JSON.stringify(ui.state.runtimeError)}`,
        )
        assert(
          !ui.html().includes('data-act="chat-reconnect"'),
          '后台流断了却在当前对话上画了「重新连接」——点它重连的是另一条流',
        )
      } finally {
        ui.stopChatStream()
      }
    })

    await test('人已经翻到别的页上了：认输只记下来，不整页重绘', async () => {
      /**
       * 切走不掐流（名单上的「跑完没有」全指望它），所以这条流完全可能在人已经翻到
       * 「机器」页之后才认输。那句话画在对话页的横幅里，在这儿重绘一次谁也看不到，
       * 代价却是把人正在填的表单整块换掉。
       */
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path, init) => {
          if (path.includes('/events')) {
            const sse = fakeSse()
            sse.close()
            return sse.response
          }
          return fetch(gwBase + path, init)
        },
      })
      await ui.boot()
      ui.state.chatSessionId = 's-away'
      ui.state.path = '/machines'
      // 把这一屏换成一个记号：重绘过就没了。
      ui.app.innerHTML = 'SENTINEL-PAGE'
      try {
        await ui.startChatStream('s-away', ui.CHAT_RETRY_MAX)
        assert(ui.state.runtimeError === '连接断开', '话还是要记下来，回到对话页时得看得见')
        assert(
          ui.html() === 'SENTINEL-PAGE',
          '人在别的页上，认输却把整页重绘了——正在填的表单会当场被换掉',
        )
      } finally {
        ui.stopChatStream()
      }
    })

    await test('管家反代不到席位（502）也要重连，不能当成永久错误', async () => {
      // 换版那几分钟里，管家转不到席位的 bot 口，回的是 502（见 manager/src/proxy.ts）。
      // 这里原先和 401/404 走同一句 return：一次 502 就等于「这条流永远没了」，而屏幕
      // 上那句「正在思考」会一直挂着——bot 早就答完了，只是没人在听。
      let hits = 0
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/events')) {
            hits += 1
            return { ok: false, status: 502, text: async () => '席位没有响应' }
          }
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      try {
        await ui.startChatStream('s-502')
        // 第一档退避 500ms。等够两档，第二次重连必须真的发生。
        for (let i = 0; i < 200 && hits < 2; i++) await new Promise((r) => setTimeout(r, 10))
        assert(hits >= 2, `502 之后一次都没重连（只打了 ${hits} 次）`)
      } finally {
        ui.stopChatStream()
      }
    })

    await test('发消息之前先确认还有人在听：流断了当场接回来', async () => {
      // 这是「更新完运行时，回复卡在界面上不动，刷新才看得见」的最后一道闸。消息 POST
      // 和事件流是两条独立的请求：流认输之后消息照发照跑，回答经 SSE 送出来时没人接。
      const sse = fakeSse()
      let events = 0
      let posted = 0
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path, init) => {
          if (path.includes('/events')) {
            events += 1
            return sse.response
          }
          if (path.includes('/messages') && init && init.method === 'POST') {
            posted += 1
            return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
          }
          // init 原样带上，否则 /me 少了 authorization，boot 会掉进登录页。
          return fetch(gwBase + path, init)
        },
      })
      await ui.boot()
      // 会话在，流已经认输了（chatAbort 被 releaseChatStream 清掉的那个状态）。
      ui.state.path = '/chat'
      ui.state.chatBotId = 'bot-a'
      ui.state.chatSessionId = 's-revive'
      ui.botStreamOf('bot-a').sessionId = 's-revive'
      ui.state.runtimeError = '连接断开'
      ui.render()
      assert(ui.html().includes('data-act="chat-reconnect"'), '前置没成立：这一屏上本该挂着那条横幅')
      ui.state.chatDraft = '还在吗'
      await ui.sendChat()
      assert(posted === 1, `消息没发出去：posted=${posted}`)
      assert(events === 1, `发送时没把断掉的流接回来（/events 打了 ${events} 次）——回复会一直卡在界面上`)
      assert(ui.state.runtimeError !== '连接断开', '重连了却还挂着「连接断开」，人只会去刷新')
      // 只清 state 是不够的：横幅只由 chatPage() 拼，不重绘的话人一边看着「断了」
      // 一边收新回复。
      assert(
        !ui.html().includes('data-act="chat-reconnect"'),
        '接回来了，屏幕上那条「连接断开」还挂着——只清了 state，没重绘',
      )
      sse.close()
      ui.stopChatStream()
    })

    await test('流式渲染合并重绘：一帧一次，不是一个 token 一次', async () => {
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        stubIds: ['chat-thread', 'chat-status'],
        fetchImpl: async (path) => (path.includes('/events') ? sse.response : fetch(gwBase + path)),
      })
      await ui.boot()
      const thread = ui.stubs.get('chat-thread')
      ui.state.chatSessionId = 's-paint'
      const run = ui.startChatStream('s-paint')
      // **先把历史放完。** 开流后的第一批事件属于重放，那一段的状态是被摁住的（见下面
      // 「重放历史时不闪「正在处理」」）。这里要测的是历史之后**真正的流式输出**——用户
      // 发完消息、模型一个 token 一个 token 吐出来的那一段，它必须逐帧画。
      sse.push({ type: 'replay/done' })
      for (let i = 0; i < 100 && ui.state.chatReplaying; i++) await new Promise((r) => setTimeout(r, 5))
      const before = thread.writes
      const N = 20
      for (let i = 0; i < N; i++) sse.push({ type: 'assistant/chunk', seq: i + 1, data: { text: 'x' } })
      for (let i = 0; i < 200 && ui.state.chatEvents.length < N; i++) {
        await new Promise((r) => setTimeout(r, 5))
      }
      assert(ui.state.chatEvents.length === N, `事件没收全：${ui.state.chatEvents.length}/${N}`)
      // 合并重绘是**延后**的（一帧一次），事件到齐不等于已经画完——这里要多等一拍，
      // 否则测的是「还没来得及画」，不是「合并了」。
      await new Promise((r) => setTimeout(r, 60))
      const writes = thread.writes - before
      assert(writes > 0, '一次都没重绘，说明根本没画')
      assert(writes <= 3, `${N} 个 token 重绘了 ${writes} 次——没有合并，长会话下是 O(n²)`)
      sse.close()
      await run
      ui.stopChatStream()
    })

    await test('重放历史时不闪「正在处理」，但也不留一片空白', async () => {
      // 打开一条会话时，SSE 把**全部历史**从头推一遍，和实时事件走同一个通道。一条
      // 8 轮的真实对话是 789 条事件。最早每收到一条就重绘一次：
      //   · O(n²)——每次都 fold 全量、比对整棵 DOM、重渲染最后那段 Markdown
      //   · 状态还是错的——重放到某轮的 turn/start 就显示「正在处理」，要等重放出配对
      //     的 turn/end 才消失。拿真实数据量过，789 帧里有 772 帧（98%）挂着「正在
      //     处理」，而那期间什么都没在跑。
      //
      // 后来改成「重放期间一帧都不画」，两条都治住了，却换来第三个毛病：闸要等
      // replay/done、或者静默 120ms、或者 4 秒硬上限才开，而刷新页面时这条流正在跟别
      // 的请求抢连接槽，事件断断续续地来——静默判定被一次次推后，屏幕上整整四秒什么
      // 都没有。「刷新之后消息迟迟不出来」说的就是这一段。
      //
      // 现在两头都要：**照画**（合并重绘由 rAF 管），而状态在 paintChat 里被摁成
      // 「没在跑」，直到席位自己表态。这个测就钉这两句话。
      //
      // 「画了没有」怎么观测：**拿 state.chatStatus 当哨兵**。paintChat 每跑一次都会
      // 写它一遍，而且写在 `if (!thread) return` **前面**——先塞一个哨兵值进去，之后
      // 它要是被抹成 '' 就说明这期间画过，而且画出来的状态不是「正在处理」。一条断言
      // 同时钉住两件事。（垫片里的 #chat-thread 只是个计数桩，撑不起真正的 syncThread，
      // 所以不走 DOM 那条路观测。）
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => (path.includes('/events') ? sse.response : fetch(gwBase + path)),
      })
      await ui.boot()
      ui.state.chatSessionId = 's-replay'
      const run = ui.startChatStream('s-replay')
      assert(ui.state.chatReplaying, '开流就该拉闸')

      let seq = 0
      const push = (type, data) => sse.push({ seq: ++seq, time: 1, type, data: data || {} })
      const settled = (turn) => {
        push('user/message', { message: { content: [{ type: 'text', text: '问题' + turn }] }, source: { kind: 'user' } })
        push('turn/start', { turn })
        for (let i = 0; i < 5; i++) push('assistant/chunk', { chunk: { type: 'text-delta', text: 'x' } })
        push('assistant/message', { turn, message: { content: [{ type: 'text', text: '回答' + turn }] } })
        push('turn/end', { turn, reason: 'completed' })
      }

      // **停在一轮的半当中**：第二轮的 turn/start 灌出来了，配对的 turn/end 还没到。
      // 这正是以前让界面挂上「正在处理」的那一帧——只灌完整的轮次是测不到它的。
      ui.state.chatStatus = '哨兵'
      settled(1)
      push('user/message', { message: { content: [{ type: 'text', text: '问题2' }] }, source: { kind: 'user' } })
      push('turn/start', { turn: 2 })
      for (let i = 0; i < 5; i++) push('assistant/chunk', { chunk: { type: 'text-delta', text: 'x' } })
      for (let i = 0; i < 200 && ui.state.chatEvents.length < seq; i++) await new Promise((r) => setTimeout(r, 5))
      assert(ui.state.chatEvents.length === seq, `事件没收全：${ui.state.chatEvents.length}/${seq}`)
      // 合并重绘是延后的（一帧一次），这里要多等一拍，否则测的是「还没来得及画」。
      await new Promise((r) => setTimeout(r, 60))

      assert(ui.state.chatReplaying, '历史还在灌，闸不该开')
      assert(
        ui.state.chatStatus === '',
        ui.state.chatStatus === '哨兵'
          ? '重放期间一次都没画——刷新之后屏幕会空着等闸开'
          : `重放期间闪了中间态：chatStatus=${JSON.stringify(ui.state.chatStatus)}`,
      )

      // 把这一轮收口，再补第三轮，凑够断言用的六条消息。
      push('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: '回答2' }] } })
      push('turn/end', { turn: 2, reason: 'completed' })
      settled(3)
      for (let i = 0; i < 200 && ui.state.chatEvents.length < seq; i++) await new Promise((r) => setTimeout(r, 5))

      // 静默兜底：连着灌完一停，就认为历史放完了（老 bot 不发 replay/done 也能收敛）。
      await new Promise((r) => setTimeout(r, 350))
      assert(!ui.state.chatReplaying, '静默之后闸该开')
      const folded = ui.fold(ui.state.chatEvents)
      assert(folded.status === '', `重放完不该是忙态：${JSON.stringify(folded.status)}`)
      assert(folded.blocks.length === 6, `应有 6 条消息，实际 ${folded.blocks.length}`)
      sse.close()
      await run
      ui.stopChatStream()
    })

    /* ── 历史和实时拆成两条路 ──────────────────────────────────────
       历史走 HTTP（hydrateChat），实时走 SSE，而流上还垫一轮兜底：名单要那行灰字，
       点进去的第一帧也要有东西可看。那一轮和 HTTP 拉回来的最后一轮**必然重叠**，
       所以两头都要挡：进桶时「比尾巴大才收」，补历史时「比头小才收」。
       两种到达顺序各测一遍——谁先到取决于网络，不该由它决定画出来对不对。
       ────────────────────────────────────────────────────────── */

    /** 一轮完整对话，seq 连号。 */
    const chatTurn = (base, n) => [
      { seq: base, time: base * 1000, type: 'user/message', data: { message: { content: [{ type: 'text', text: '问题' + n }] }, source: { kind: 'user' } } },
      { seq: base + 1, time: base * 1000, type: 'turn/start', data: { turn: n } },
      { seq: base + 2, time: base * 1000, type: 'assistant/message', data: { turn: n, message: { content: [{ type: 'text', text: '回答' + n }] } } },
      { seq: base + 3, time: base * 1000, type: 'turn/end', data: { turn: n, reason: 'completed' } },
    ]
    const THREE_TURNS = [...chatTurn(1, 1), ...chatTurn(5, 2), ...chatTurn(9, 3)]

    /** 接管 /history 和 /events 的 app 实例。history 回的是三轮全量。 */
    const twoPathUi = async (sse, onHistory) => {
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/history')) {
            if (onHistory) onHistory(path)
            return new Response(JSON.stringify({ events: THREE_TURNS, firstSeq: 1, hasMore: false }), {
              headers: { 'content-type': 'application/json' },
            })
          }
          if (path.includes('/events')) return sse.response
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      return ui
    }

    await test('流先到、历史后到：重叠的那一轮不画两遍', async () => {
      const sse = fakeSse()
      const seen = []
      const ui = await twoPathUi(sse, (path) => seen.push(path))
      const row = ui.botStreamOf('bot-two-path')
      row.sessionId = 's-two-a'
      ui.state.chatBotId = 'bot-two-path'
      ui.state.chatSessionId = 's-two-a'
      ui.state.chatEvents = row.events

      const run = ui.startChatStream('s-two-a', 0, 'bot-two-path')
      // 流垫的那一轮 = 最后一轮，和 history 的尾巴完全重叠。
      for (const ev of chatTurn(9, 3)) sse.push(ev)
      sse.push({ type: 'replay/done', live: false, firstSeq: 9, hasMore: true })
      for (let i = 0; i < 200 && row.events.length < 4; i++) await new Promise((r) => setTimeout(r, 5))
      assert(row.events.length === 4, `流垫的一轮没收全：${row.events.length}`)

      await ui.hydrateChat('bot-two-path', 's-two-a')
      const seqs = row.events.map((e) => e.seq)
      assert(
        JSON.stringify(seqs) === JSON.stringify(THREE_TURNS.map((e) => e.seq)),
        `归并结果不对（该是 1..12 无重复）：${JSON.stringify(seqs)}`,
      )
      const folded = ui.fold(row.events)
      assert(folded.blocks.length === 6, `该是 3 问 3 答共 6 条，实际 ${folded.blocks.length}`)
      // 游标只许往前推：replay/done 说的是 9，HTTP 说的是 1，最后要留 1。
      assert(ui.chatPages.get('s-two-a').firstSeq === 1, `翻页游标被缩回去了：${JSON.stringify(ui.chatPages.get('s-two-a'))}`)
      assert(seen.length === 1 && seen[0].includes('turns=' + ui.CHAT_TAIL_TURNS), `历史那一跳不对：${JSON.stringify(seen)}`)
      sse.close()
      await run
      ui.stopChatStream()
    })

    await test('历史先到、流后到：重放段整段被认成重复', async () => {
      const sse = fakeSse()
      const ui = await twoPathUi(sse)
      const row = ui.botStreamOf('bot-two-path')
      row.sessionId = 's-two-b'
      ui.state.chatBotId = 'bot-two-path'
      ui.state.chatSessionId = 's-two-b'
      ui.state.chatEvents = row.events

      await ui.hydrateChat('bot-two-path', 's-two-b')
      assert(row.events.length === 12, `历史没进桶：${row.events.length}`)
      assert(row.hydrated === true, 'hydrated 没置位')

      const run = ui.startChatStream('s-two-b', 0, 'bot-two-path')
      for (const ev of chatTurn(9, 3)) sse.push(ev)
      sse.push({ type: 'replay/done', live: false })
      await new Promise((r) => setTimeout(r, 120))
      assert(row.events.length === 12, `重放段被重复收下了：${row.events.length}`)

      // 真正的新事件照收。
      for (const ev of chatTurn(13, 4)) sse.push(ev)
      for (let i = 0; i < 200 && row.events.length < 16; i++) await new Promise((r) => setTimeout(r, 5))
      assert(row.events.length === 16, `新一轮没收进来：${row.events.length}`)
      assert(row.sum.lastText === '回答4', `名单摘要不对：${JSON.stringify(row.sum.lastText)}`)
      sse.close()
      await run
      ui.stopChatStream()
    })

    await test('流上只垫一轮，二十轮那份改走 HTTP', async () => {
      // 名单上每个 Bot 都挂一条流。以前每条一上来都推二十轮历史，几个 Bot 乘二十轮
      // 全在主线程上 parse，换来的只是侧栏一行字。
      const sse = fakeSse()
      let streamUrl = ''
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/events')) {
            streamUrl = path
            return sse.response
          }
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      ui.state.chatSessionId = 's-tail'
      const run = ui.startChatStream('s-tail')
      for (let i = 0; i < 100 && !streamUrl; i++) await new Promise((r) => setTimeout(r, 5))
      assert(streamUrl.includes('tail=' + ui.STREAM_TAIL_TURNS), `流上的 tail 不对：${streamUrl}`)
      assert(ui.STREAM_TAIL_TURNS === 1, `流上该只垫一轮，实际 ${ui.STREAM_TAIL_TURNS}`)
      assert(ui.CHAT_TAIL_TURNS === 20, `历史一页该是二十轮，实际 ${ui.CHAT_TAIL_TURNS}`)
      sse.close()
      await run
      ui.stopChatStream()
    })

    await test('远程 Bot 没给 streamUrl：一个 fetch 都不发，直接说「没配直连地址」', async () => {
      /**
       * Gateway 不再反代对话流，`/runtime/sessions/:id/events` 已经不存在。名单上那颗
       * Bot 明确带着 runtime 却没有 streamUrl（机器没填 directUrl、或管家太旧），前端要
       * **当场**把原因画出来，而不是去打一条早没了的路、等它 404 再退避重连——那样人
       * 看到的是转圈，永远等不到一句解释。
       */
      let hits = 0
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path, init) => {
          if (path.includes('/events')) hits++
          return fetch(gwBase + path, init)
        },
      })
      await ui.boot()
      ui.state.runtimeBots = [{ id: 'bot-far', name: 'FAR', runtime: { status: 'ready', streamUrl: null } }]
      ui.state.chatSessionId = 's-far'
      try {
        await ui.startChatStream('s-far', 0, 'bot-far')
        await new Promise((r) => setTimeout(r, 50))
        assert(hits === 0, `没有直连地址还去连了 ${hits} 次——Gateway 上早没这条路了`)
        assert(String(ui.state.runtimeError).includes('没有配直连地址'), `没把原因画出来：${ui.state.runtimeError}`)
      } finally {
        ui.stopChatStream()
      }
    })

    await test('上传认这条会话的主人，不认界面当下选中的那颗 Bot', async () => {
      /**
       * 上传是一个文件一个文件发的，`sessionId` 在循环外就钉死了，而上传地址每一轮都
       * 重算一次。以前那一行是 `state.chatBotId || botIdOfSession(sessionId)`——人在传的
       * 中途切了个席位，第 N 个文件就带着第一条会话的 id 打到**另一个**席位的 uploadUrl
       * 上；那边查得出这条会话不存在，回 404，界面上只剩一句「附件没传上去」加一个看
       * 不懂的状态码。所以次序要反过来：会话的主人优先，界面选中的只是兜底。
       */
      const ui = loadApp({ appPath, base: gwBase, token: adminToken })
      await ui.boot()
      ui.botStreamOf('bot-up-a').sessionId = 's-up-a'
      ui.botStreamOf('bot-up-b').sessionId = 's-up-b'
      ui.state.runtimeBots = [
        { id: 'bot-up-a', name: 'A', runtime: { status: 'ready', uploadUrl: 'https://m-a.example/seats/seat-a/stream' } },
        { id: 'bot-up-b', name: 'B', runtime: { status: 'ready', uploadUrl: 'https://m-b.example/seats/seat-b/stream' } },
      ]
      // 界面上选中的是 B，但这条会话是 A 的。
      ui.state.chatBotId = 'bot-up-b'
      const target = ui.uploadTargetOf('s-up-a')
      assert(target && target.local === false, `远程 Bot 不该走本地那条：${JSON.stringify(target)}`)
      assert(
        target.url === 'https://m-a.example/seats/seat-a/stream/sessions/s-up-a/files',
        `上传打到了别的席位上：${target.url}`,
      )

      // 会话查不到主人时才落到界面选中的那颗——兜底还得在。
      const fallback = ui.uploadTargetOf('s-nobody')
      assert(
        fallback && fallback.url === 'https://m-b.example/seats/seat-b/stream/sessions/s-nobody/files',
        `兜底没落到界面选中的那颗：${JSON.stringify(fallback)}`,
      )

      /**
       * 远程 Bot 没配 uploadUrl：一个字节都不发，给一句说得清的话。以前这种也退回
       * `/runtime/...`，可 Gateway 上那条路已经删干净了，走过去只换来一个生的 404。
       */
      ui.state.runtimeBots = [{ id: 'bot-up-a', name: 'A', runtime: { status: 'ready', uploadUrl: null } }]
      assert(ui.uploadTargetOf('s-up-a') === null, '没配 uploadUrl 时该给 null，不该拼一个 /runtime/ 出来')
      let msg = ''
      try {
        await ui.uploadChatFile('s-up-a', { name: 'x.txt', size: 1 })
      } catch (e) {
        msg = String(e.message || e)
      }
      assert(msg.includes('没有配直连地址'), `该抛那句「没配直连地址」，实际 ${JSON.stringify(msg)}`)
    })

    await test('拉历史途中会话被重建：这一份作废，不串台', async () => {
      const sse = fakeSse()
      const ui = await twoPathUi(sse)
      const row = ui.botStreamOf('bot-two-path')
      row.sessionId = 's-old'
      ui.state.chatBotId = 'bot-two-path'
      ui.state.chatSessionId = 's-old'
      ui.state.chatEvents = row.events
      const job = ui.hydrateChat('bot-two-path', 's-old')
      // 席位重建了会话——这份历史属于另一条对话。
      ui.resetBotStream(row)
      row.sessionId = 's-new'
      await job
      assert(row.events.length === 0, `串台的历史进桶了：${row.events.length}`)
      assert(row.hydrated === false, '作废的那次不该置 hydrated')
      sse.close()
    })

    await test('席位重建了会话：旧流被掐掉，新会话真的连得上', async () => {
      // resetBotStream 一度只清数据（事件、摘要、hydrated），把 row.ac 留着。而调用方
      // 紧接着就把 row.sessionId 改成新的，于是 startChatStream 的「已经在跑」闸
      // （row.sessionId === sessionId && row.ac）误触发、直接 return——新会话一条流都
      // 开不出来。更糟的是旧流还活着，继续往这只刚清空的桶里灌旧会话的事件。
      const first = fakeSse()
      const second = fakeSse()
      const opened = []
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/history')) {
            return new Response(JSON.stringify({ events: [], firstSeq: null, hasMore: false }), {
              headers: { 'content-type': 'application/json' },
            })
          }
          if (path.includes('/events')) {
            opened.push(path)
            return opened.length === 1 ? first.response : second.response
          }
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      const row = ui.botStreamOf('bot-rebuilt')
      ui.state.chatBotId = 'bot-rebuilt'
      ui.state.chatSessionId = 's-old'
      ui.state.chatEvents = row.events
      void ui.startChatStream('s-old', 0, 'bot-rebuilt')
      for (let i = 0; i < 200 && !opened.length; i++) await new Promise((r) => setTimeout(r, 5))
      assert(row.ac, '第一条流没记到行上')

      // 席位重建 —— 走 ensureChatSession 冷路径的那两步。
      ui.resetBotStream(row)
      assert(!row.ac, '旧流的 ac 没清掉，「已经在跑」闸会拿它误认新会话')
      row.sessionId = 's-new'
      ui.state.chatSessionId = 's-new'
      void ui.startChatStream('s-new', 0, 'bot-rebuilt')
      for (let i = 0; i < 200 && opened.length < 2; i++) await new Promise((r) => setTimeout(r, 5))
      assert(opened.length === 2, `新会话的流没开出来：${JSON.stringify(opened)}`)

      // 掐掉的那条就算还有半截数据在手，也不该落进新会话的桶里。
      first.push({ seq: 99, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '旧会话的话' }] }, source: { kind: 'user' } } })
      // 负向断言：等够 300ms，串进来的话这时早串了；60ms 只是「还没来得及」。
      await new Promise((r) => setTimeout(r, 300))
      assert(
        !JSON.stringify(row.events).includes('旧会话的话'),
        `旧会话的事件串进新会话了：${JSON.stringify(row.events)}`,
      )
      first.close()
      second.close()
      ui.stopChatStream()
    })

    await test('席位重建时正在拉历史：新会话不会被那把闸挡在门外', async () => {
      // 「别拉两遍」的闸认的是 row.hydrating。它拉的是**旧**会话的历史，重建之后不清
      // 掉的话，新会话这次 hydrate 会拿到旧会话那只 promise 就直接返回；旧的一醒来
      // 发现串台自己走了，于是新会话的历史从此没人去拉。
      const sse = fakeSse()
      const asked = []
      let release
      const gate = new Promise((r) => (release = r))
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/history')) {
            asked.push(path)
            // 第一次（旧会话那次）挂住，制造「正在飞」的窗口。
            if (asked.length === 1) await gate
            return new Response(JSON.stringify({ events: THREE_TURNS, firstSeq: 1, hasMore: false }), {
              headers: { 'content-type': 'application/json' },
            })
          }
          if (path.includes('/events')) return sse.response
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      const row = ui.botStreamOf('bot-hydrating')
      row.sessionId = 's-old'
      ui.state.chatBotId = 'bot-hydrating'
      ui.state.chatSessionId = 's-old'
      ui.state.chatEvents = row.events
      const stale = ui.hydrateChat('bot-hydrating', 's-old')
      for (let i = 0; i < 200 && !asked.length; i++) await new Promise((r) => setTimeout(r, 5))
      assert(row.hydrating, '在飞的 hydrate 没记到行上')

      ui.resetBotStream(row)
      assert(!row.hydrating, '在飞的 hydrate 没清掉，新会话会被它挡住')
      row.sessionId = 's-new'
      ui.state.chatSessionId = 's-new'
      await ui.hydrateChat('bot-hydrating', 's-new')
      assert(asked.length === 2, `新会话没去拉历史：${JSON.stringify(asked)}`)
      assert(row.events.length === 12, `新会话的历史没进桶：${row.events.length}`)
      assert(row.hydrated === true, '新会话的 hydrated 没置位')

      release()
      await stale
      // 旧那次醒来发现串台，不该把自己那份塞进来，也不该改动结论。
      assert(row.events.length === 12, `串台的历史挤进来了：${row.events.length}`)
      sse.close()
    })

    await test('历史接口回了个空 body：不炸，也不把这个 Bot 永久钉死', async () => {
      // api() 在 body 为空时返回 null（Gateway 的 proxyJson 同样把席位的空 body 转成
      // 200 + null）。裸取 data.firstSeq 会当场抛，而那时 hydrated 已经置位——于是这个
      // Bot 从此不再重拉，永远停在流垫的那一轮。
      const sse = fakeSse()
      let calls = 0
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/history')) {
            calls++
            if (calls === 1) return new Response('', { headers: { 'content-type': 'application/json' } })
            return new Response(JSON.stringify({ events: THREE_TURNS, firstSeq: 1, hasMore: false }), {
              headers: { 'content-type': 'application/json' },
            })
          }
          if (path.includes('/events')) return sse.response
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      const row = ui.botStreamOf('bot-empty-body')
      row.sessionId = 's-empty'
      ui.state.chatBotId = 'bot-empty-body'
      ui.state.chatSessionId = 's-empty'
      ui.state.chatEvents = row.events

      await ui.hydrateChat('bot-empty-body', 's-empty')
      assert(row.hydrated === false, '空 body 当成拉到了，这个 Bot 就再也不会重拉')
      // 第二次要真的重来一遍，并且能拿到东西。
      await ui.hydrateChat('bot-empty-body', 's-empty')
      assert(calls === 2, `没有重试：calls=${calls}`)
      assert(row.events.length === 12, `重试之后历史还是没进桶：${row.events.length}`)
      sse.close()
    })

    await test('翻页游标只许往前推——loadOlderChat 也不例外', async () => {
      // chatPages.firstSeq 有三个写入方（replay/done、hydrateChat、loadOlderChat），
      // 而它们看到的窗口不一样大。窄的那份晚到时如果照写，游标就退回去了：下一次
      // 「加载更早」取的是一页手上全有的事件，归并那两道闸把它们全滤掉，按钮点了
      // 没反应。
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/history')) {
            // 这一页比手上知道的**窄**：从 seq 5 开始，而 hydrate 已经知道 1 了。
            return new Response(JSON.stringify({ events: chatTurn(5, 2), firstSeq: 5, hasMore: true }), {
              headers: { 'content-type': 'application/json' },
            })
          }
          if (path.includes('/events')) return sse.response
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      const row = ui.botStreamOf('bot-cursor')
      row.sessionId = 's-cursor'
      ui.state.chatBotId = 'bot-cursor'
      ui.state.chatSessionId = 's-cursor'
      ui.state.chatEvents = row.events
      row.events.push(...THREE_TURNS)
      // 先记下宽的那份（hydrateChat 拉回二十轮时的样子）。
      ui.chatPages.set('s-cursor', { firstSeq: 1, hasMore: true, loading: false })

      await ui.loadOlderChat('s-cursor')
      const page = ui.chatPages.get('s-cursor')
      assert(page.firstSeq === 1, `游标被窄的那一页推回去了：${JSON.stringify(page)}`)
      assert(page.loading === false, `翻完了没解灰：${JSON.stringify(page)}`)
      sse.close()
    })

    await test('bot 说了 replay/done 就立刻开闸，不用等静默', async () => {
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => (path.includes('/events') ? sse.response : fetch(gwBase + path)),
      })
      await ui.boot()
      ui.state.chatSessionId = 's-mark'
      const run = ui.startChatStream('s-mark')
      sse.push({ seq: 1, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '嗨' }] }, source: { kind: 'user' } } })
      sse.push({ type: 'replay/done' })
      for (let i = 0; i < 100 && ui.state.chatReplaying; i++) await new Promise((r) => setTimeout(r, 5))
      assert(!ui.state.chatReplaying, 'replay/done 之后闸该立刻开')
      // 标记本身不是会话事件，不该混进正文里
      assert(ui.state.chatEvents.length === 1, `标记被当成消息收下了：${JSON.stringify(ui.state.chatEvents)}`)
      sse.close()
      await run
      ui.stopChatStream()
    })

    await test('bot 说了没在跑，就别再挂着「正在处理」', async () => {
      // 历史被截断在 turn/start 上时，扫事件扫出来的结论一定是「在跑」——而它可能几
      // 小时前就结束了。两条路都会走到这儿，而且都很常见：流断在重放中途（尾巴那条
      // turn/end 没到），或者进程半路没了、日志里那条 turn/end 根本没写成。
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => (path.includes('/events') ? sse.response : fetch(gwBase + path)),
      })
      await ui.boot()
      ui.state.chatSessionId = 's-live'
      const run = ui.startChatStream('s-live')
      sse.push({ seq: 1, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '嗨' }] }, source: { kind: 'user' } } })
      sse.push({ seq: 2, time: 1, type: 'turn/start', data: { turn: 1 } })
      sse.push({ type: 'replay/done', live: false })
      for (let i = 0; i < 100 && ui.state.chatReplaying; i++) await new Promise((r) => setTimeout(r, 5))
      assert(
        ui.state.chatStatus === '',
        `bot 说了没在跑，界面还挂着「正在处理」：${JSON.stringify(ui.state.chatStatus)}`,
      )

      // 之后由实时的 turn 事件接着维护：真开跑了就得点亮。
      sse.push({ seq: 3, time: 1, type: 'turn/start', data: { turn: 2 } })
      for (let i = 0; i < 100 && ui.state.chatStatus === ''; i++) await new Promise((r) => setTimeout(r, 5))
      assert(ui.state.chatStatus === 'running', '真开跑了却没点亮')
      sse.push({ seq: 4, time: 1, type: 'turn/end', data: { turn: 2, reason: 'completed' } })
      for (let i = 0; i < 100 && ui.state.chatStatus !== ''; i++) await new Promise((r) => setTimeout(r, 5))
      assert(ui.state.chatStatus === '', '跑完了没灭')
      sse.close()
      await run
      ui.stopChatStream()
    })

    await test('闸已经自己开过了，replay/done 的结论照样要画出来', async () => {
      // 这条抓的是线上那个真实故障：一段 988 条的历史，重放必然撞上 4 秒硬上限（或
      // 120ms 静默兜底），闸提前开了。等 replay/done 带着 live=false 到达时，endReplay
      // 第一行就是「闸开过了就 return」——结论存进了 chatLive，一帧都没画。而这之后
      // 不会再有任何事件来触发重绘（它说的就是「没在跑」），界面于是永远停在开闸那
      // 一刻：一个悬着的 turn/start，一句「正在处理」。
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => (path.includes('/events') ? sse.response : fetch(gwBase + path)),
      })
      await ui.boot()
      ui.state.chatSessionId = 's-late'
      const run = ui.startChatStream('s-late')
      sse.push({ seq: 1, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '嗨' }] }, source: { kind: 'user' } } })
      sse.push({ seq: 2, time: 1, type: 'turn/start', data: { turn: 1 } })

      // **先让闸自己开**——这正是长历史下必然发生的事，也是这条用例的前提。
      for (let i = 0; i < 200 && ui.state.chatReplaying; i++) await new Promise((r) => setTimeout(r, 5))
      assert(!ui.state.chatReplaying, '前置没成立：闸还没自己开')
      assert(ui.state.chatStatus === 'running', `前置没成立：此刻按扫描该是忙的，实际 ${JSON.stringify(ui.state.chatStatus)}`)

      // 现在 bot 才说「没在跑」。晚到不等于不算数。
      sse.push({ type: 'replay/done', live: false })
      for (let i = 0; i < 200 && ui.state.chatStatus !== ''; i++) await new Promise((r) => setTimeout(r, 5))
      assert(
        ui.state.chatStatus === '',
        `bot 说了没在跑，界面却还挂着——结论没被画出来：${JSON.stringify(ui.state.chatStatus)}`,
      )
      sse.close()
      await run
      ui.stopChatStream()
    })

    await test('重放停在半路：带着游标自己重连，把缺的那截补回来', async () => {
      // 线上实测：bot 报「重放 1078 条」，客户端只收到 1054 条，replay/done 从没到达，
      // 连接还开着也不会重连。原因是 bot 那边 enqueue 不阻塞，尾巴压在下游的缓冲里，
      // 而一条安静的会话再也不会有新字节把它顶出去。表现是历史缺一截 + 永远「正在处理」。
      const first = fakeSse()
      const second = fakeSse()
      const urls = []
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (!path.includes('/events')) return fetch(gwBase + path)
          urls.push(path)
          return urls.length === 1 ? first.response : second.response
        },
      })
      await ui.boot()
      ui.state.chatSessionId = 's-stall'
      void ui.startChatStream('s-stall', 0, 'bot-stall')

      // 收了两条就断供，且**不发** replay/done——正是卡住的样子。
      first.push({ seq: 1, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '嗨' }] }, source: { kind: 'user' } } })
      first.push({ seq: 2, time: 1, type: 'turn/start', data: { turn: 1 } })
      for (let i = 0; i < 200 && urls.length < 1; i++) await new Promise((r) => setTimeout(r, 5))

      // 看门狗到点应该带着游标重连，而不是干等下去。
      for (let i = 0; i < 300 && urls.length < 2; i++) await new Promise((r) => setTimeout(r, 50))
      assert(urls.length === 2, `没有重连——重放卡住就一直卡着了：${JSON.stringify(urls)}`)
      assert(
        /after=2(&|$)/.test(urls[1]),
        `重连没带游标，会从 0 再放一遍（缓冲边界照样卡同一处）：${urls[1]}`,
      )

      // 补上剩下的一截 + replay/done，界面该收敛。
      second.push({ seq: 3, time: 1, type: 'turn/end', data: { turn: 1, reason: 'completed' } })
      second.push({ type: 'replay/done', live: false })
      for (let i = 0; i < 300 && ui.state.chatStatus !== ''; i++) await new Promise((r) => setTimeout(r, 20))
      assert(ui.state.chatStatus === '', `补齐之后还挂着：${JSON.stringify(ui.state.chatStatus)}`)
      first.close()
      second.close()
      ui.stopChatStream()
    })

    await test('打开对话只要最近几轮，往前翻再一页页取', async () => {
      // 以前是整段推：实测 1078 条，每次刷新都从头灌一遍。慢，而且尾巴容易压在下游
      // 缓冲里出不来——「历史缺一截 + 永远正在处理」就是这么来的。
      const sse = fakeSse()
      const urls = []
      const older = [
        { seq: 5, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '很早以前' }] }, source: { kind: 'user' } } },
        { seq: 6, time: 1, type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '很早的回答' }] } } },
      ]
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          urls.push(path)
          if (path.includes('/history')) {
            return { ok: true, status: 200, text: async () => JSON.stringify({ events: older, firstSeq: 5, hasMore: false }) }
          }
          if (path.includes('/events')) return sse.response
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      ui.state.chatSessionId = 's-page'
      void ui.startChatStream('s-page')
      for (let i = 0; i < 200 && !urls.some((u) => u.includes('/events')); i++) await new Promise((r) => setTimeout(r, 5))
      const open = urls.find((u) => u.includes('/events'))
      assert(/[?&]tail=\d+/.test(open), `头一次连没带 tail，还是会把整段历史推一遍：${open}`)

      sse.push({ seq: 10, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '最近的' }] }, source: { kind: 'user' } } })
      sse.push({ seq: 11, time: 1, type: 'assistant/message', data: { turn: 2, step: 0, message: { content: [{ type: 'text', text: '最近的回答' }] } } })
      sse.push({ type: 'replay/done', live: false, firstSeq: 10, hasMore: true })
      for (let i = 0; i < 200 && ui.state.chatEvents.length < 2; i++) await new Promise((r) => setTimeout(r, 5))

      // 前面还有，顶上就该有一行入口。
      const rows = ui.threadRows(ui.fold(ui.state.chatEvents), 's-page')
      assert(rows[0] && rows[0].kind === 'more', `顶上没有「加载更早」：${JSON.stringify(rows.map((r) => r.kind))}`)

      await ui.loadOlderChat('s-page')
      const page = urls.find((u) => u.includes('/history'))
      assert(page && /before=10/.test(page), `翻页没带游标，会把同一段再取一遍：${page}`)
      // 旧的要插在**开头**，顺序不能乱。
      assert(ui.state.chatEvents[0].seq === 5, `旧消息没插到开头：${ui.state.chatEvents.map((e) => e.seq).join(',')}`)
      const after = ui.threadRows(ui.fold(ui.state.chatEvents), 's-page')
      assert(!after.some((r) => r.kind === 'more'), '翻到头了还挂着「加载更早」')
      assert(after.filter((r) => r.kind === 'msg').length === 4, `四条消息该都在：${after.filter((r) => r.kind === 'msg').length}`)
      sse.close()
      ui.stopChatStream()
    })

    await test('「正在想」那条占位不占真实消息的 key', async () => {
      // 真实消息的 key 是 `'m' + seq`（会话日志的**行号**），占位那条以前用的是
      // `'m' + 块数`——两套数，撞上就是同一个 key。撞了之后 syncThread 按 key 认节点，
      // 会把底下的占位节点搬到那条早期消息的位置（正文换成它的、外壳还是助手的头像和
      // 左对齐），被顶掉的那个既不排序也不清理，一路漂到最下面：界面上就是「前面那句
      // 话跳到了后面」，刷新才好。这里造的正是最容易撞的形状：三块，最后一块 seq 也是 3。
      const ui = loadApp({ appPath, base: gwBase, token: adminToken })
      const evs = [
        { seq: 1, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '在吗' }] }, source: { kind: 'user' } } },
        { seq: 2, time: 1, type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '在的，请讲～' }] } } },
        { seq: 3, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '查一下当前目录' }] }, source: { kind: 'user' } } },
        { seq: 4, time: 1, type: 'turn/start', data: { turn: 2 } },
      ]
      const folded = ui.fold(evs)
      assert(folded.status === 'running', `轮次没开着，这条测的形状就不对了：${JSON.stringify(folded.status)}`)
      const rows = ui.threadRows(folded, 's-key')
      assert(rows[rows.length - 1].block.kind === 'assistant', '末尾没补出「正在想」那条占位')
      const keys = rows.map((r) => r.key)
      const dup = keys.filter((k, i) => keys.indexOf(k) !== i)
      assert(!dup.length, `两行认同一个 key，界面会错位：${dup.join(',')} / ${keys.join(',')}`)
    })

    await test('老 bot 不带 live 字段：照旧按事件扫，不改行为', async () => {
      // 席位上的 bot 比 Gateway 旧一步是常态（要重新部署才换版本）。它发的 replay/done
      // 上没有 live，这时候只能回落到扫描——可以不如新版准，但不能比以前更差。
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => (path.includes('/events') ? sse.response : fetch(gwBase + path)),
      })
      await ui.boot()
      ui.state.chatSessionId = 's-old'
      const run = ui.startChatStream('s-old')
      sse.push({ seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } })
      sse.push({ type: 'replay/done' })
      for (let i = 0; i < 100 && ui.state.chatReplaying; i++) await new Promise((r) => setTimeout(r, 5))
      assert(ui.state.chatStatus === 'running', `老 bot 那条路被改坏了：${JSON.stringify(ui.state.chatStatus)}`)
      sse.close()
      await run
      ui.stopChatStream()
    })

    await test('换 Bot：席位没起来时也不能留着上一个 Bot 的对话', async () => {
      // 原来是等新会话拿回来、比对出 sessionId 变了才清正文。新 Bot 的席位没上线时那步
      // 走不到（503 就地 return），于是切过去之后屏幕上还挂着**上一个 Bot 的聊天记录**，
      // 旧的那条流还连着，还在往里追消息。
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/events')) return sse.response
          // bot-b 的席位没起来
          if (path.includes('/bots/bot-b/session')) return { ok: false, status: 503, text: async () => '实例还没上线' }
          if (path.includes('/bots/bot-a/session')) return { ok: true, status: 200, text: async () => JSON.stringify({ sessionId: 's-a' }) }
          return fetch(gwBase + path)
        },
      })
      await ui.boot()

      await ui.ensureChatSession('bot-a')
      ui.state.chatEvents.push({ seq: 1, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'A 的悄悄话' }] }, source: { kind: 'user' } } })
      assert(ui.state.chatEvents.length === 1, '前置没成立')

      await ui.ensureChatSession('bot-b')
      assert(ui.state.chatEvents.length === 0, `切到没上线的 Bot 之后还留着 ${ui.state.chatEvents.length} 条上一个 Bot 的消息`)
      assert(ui.state.chatSessionId === '', `会话 id 还指着上一条：${ui.state.chatSessionId}`)
      assert(ui.state.chatBotId === 'bot-b', `chatBotId 应为 bot-b，实际 ${ui.state.chatBotId}`)
      ui.stopChatStream()
      sse.close()
    })

    await test('席位刚上线：会话没拿到要自己再来一次，别等人去刷新', async () => {
      // 「刚部署完点发送没反应，刷新一下就好了」——刷新之所以管用，是因为它重跑
      // loadChatPage、重新拿了一次会话。席位报 ready 之后还有几十秒接不了话，而拿
      // 会话那一跳原先只试一次：chatSessionId 留空，sendChat 开头那道闸就把每一次
      // 发送都无声吞掉。
      let calls = 0
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/events')) return sse.response
          if (path.includes('/bots/bot-a/session')) {
            calls += 1
            // 头一跳撞上还没热起来的席位，第二跳它就好了。
            if (calls === 1) return { ok: false, status: 503, text: async () => '实例还没上线' }
            return { ok: true, status: 200, text: async () => JSON.stringify({ sessionId: 's-a' }) }
          }
          return fetch(gwBase + path)
        },
      })
      await ui.boot()

      await ui.ensureChatSession('bot-a')
      assert(ui.state.chatSessionId === '', '前置没成立：503 那一跳不该拿到会话')

      for (let i = 0; i < 200 && !ui.state.chatSessionId; i++) await new Promise((r) => setTimeout(r, 10))
      assert(ui.state.chatSessionId === 's-a', `503 之后没有自己再拿一次会话（试了 ${calls} 次）`)
      assert(!ui.state.runtimeError, `接上了还留着一句已经不成立的话：${ui.state.runtimeError}`)
      ui.stopChatStream()
      sse.close()
    })

    await test('这颗 Bot 不是你的：404 当场说清楚，不做十几次白等的重试', async () => {
      // 席位那种「我还不认识它」的 404 由 Gateway 折成 503（见 routes/runtime.ts），
      // 所以走到前端的 404 只剩「这颗 Bot 不是你的／已经删了」这一种——重试只会白敲
      // 接口，再拿「实例还没接上」把真正的原因盖掉。
      let calls = 0
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/bots/bot-gone/session')) {
            calls += 1
            return { ok: false, status: 404, text: async () => JSON.stringify({ error: '没有这个 Bot' }) }
          }
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      let threw = ''
      try {
        await ui.ensureChatSession('bot-gone')
      } catch (e) {
        threw = e.message
      }
      assert(threw.includes('没有这个 Bot'), `404 该照旧抛出来，实际：${JSON.stringify(threw)}`)
      await new Promise((r) => setTimeout(r, 700))
      assert(calls === 1, `404 不该重试，实际敲了 ${calls} 次`)
      ui.stopChatStream()
    })

    await test('没有会话时点发送：要说一句，不能一声不吭', async () => {
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          // 这一条要是发出去了，就说明那道闸放行了——会话都没有，它只会 404。
          if (path.includes('/messages')) throw new Error('会话是空的，不该发出这条消息')
          if (path.includes('/bots/bot-a/session')) return { ok: false, status: 503, text: async () => '实例还没上线' }
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      ui.state.chatBotId = 'bot-a'
      ui.state.chatSessionId = ''
      ui.state.chatDraft = '在吗'
      await ui.sendChat()
      assert(ui.state.error, '点了发送什么都没说——这正是那个「点了没反应」的 bug')
      // 草稿要留着：这条根本没发出去，凭什么把人打的字清掉。
      assert(ui.state.chatDraft === '在吗', `草稿被吞了：${JSON.stringify(ui.state.chatDraft)}`)
      // 那一下顺手催的「再拿一遍会话」这会儿刚排上（席位一直是 503）。等它排完再掐，
      // 否则这条链会在测跑完之后自己接着敲十几次接口。
      await new Promise((r) => setTimeout(r, 30))
      ui.stopChatStream()
    })

    await test('换 Bot：旧流还在跑，但它的事件绝不落进新会话', async () => {
      const sseA = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/events')) return sseA.response
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      ui.state.chatSessionId = 's-a'
      const run = ui.startChatStream('s-a')
      sseA.push({ type: 'assistant/chunk', seq: 1, data: { chunk: { type: 'text-delta', text: 'A' } } })
      for (let i = 0; i < 100 && ui.state.chatEvents.length < 1; i++) await new Promise((r) => setTimeout(r, 5))
      assert(ui.state.chatEvents.length === 1, '前置没成立')

      // 人切走了：当前会话已经换成 s-b，但 s-a 那条流**照旧在跑**——侧栏名单上那个
      // Bot 的转圈和「最近回复」就指望它。要守的是「它的事件不许串到新会话的正文里」，
      // 不是「把它掐掉」。
      ui.state.chatSessionId = 's-b'
      ui.state.chatEvents = []
      sseA.push({ type: 'assistant/chunk', seq: 2, data: { chunk: { type: 'text-delta', text: '迟到的 A' } } })
      // 负向断言：等够 300ms，落进来的话这时早落了；40ms 只是「还没来得及」。
      await new Promise((r) => setTimeout(r, 300))
      assert(
        ui.state.chatEvents.length === 0,
        `旧流的事件落进了新会话：${JSON.stringify(ui.state.chatEvents)}`,
      )
      sseA.close()
      await run
      ui.stopChatStream()
    })

    await test('桶淘汰不许动正看着的那条会话的事件数组', async () => {
      /**
       * `state.chatEvents` 和某一行的 `row.events` 是**同一个数组对象**（见
       * ensureChatSession 那三处赋值）。桶淘汰要是把它换成新数组，别名就断了：新事件
       * 落进新数组，屏幕上那份还指着旧的——**正在看的对话静默停止更新**，而且不报错、
       * 刷新之前一直如此。所以清空只许 `length = 0`，而且正看着的那一行压根不能碰。
       *
       * 会撞上的场景很具体：那条流断在重连间隙（`ac` 为 null），别的 Bot 这时开了流、
       * 顺手调了 trimBotStreams——`keepId` 挡不住它，keepId 是那个别的 Bot。
       */
      const ui = await boot(adminToken)
      const msg = (seq) => ({ seq, time: seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } })
      for (let i = 0; i < ui.BOT_BUCKET_MAX + 2; i++) {
        const r = ui.botStreamOf('cold-' + i)
        r.events.push(msg(1))
        r.sum.lastAt = i + 10
      }
      // 正看着的那个：ac 为 null（断在重连间隙），lastAt 最小所以排在淘汰队首。
      const cur = ui.botStreamOf('bot-cur')
      cur.events.push(msg(1))
      cur.sum.lastAt = 1
      ui.state.chatEvents = cur.events

      ui.trimBotStreams('some-other-bot')

      assert(ui.state.chatEvents === ui.botStreamOf('bot-cur').events, 'events 被换成新数组了——那条对话从此不再更新')
      assert(ui.state.chatEvents.length === 1, `正看着的那条会话被清空了：${ui.state.chatEvents.length}`)
      // 该淘汰的还是要淘汰掉，否则这个测只是把闸关死了。
      const left = Array.from({ length: ui.BOT_BUCKET_MAX + 2 }, (_, i) => ui.botStreamOf('cold-' + i)).filter((r) => r.events.length)
      assert(left.length === ui.BOT_BUCKET_MAX, `冷桶没按上限淘汰：还剩 ${left.length}`)
    })

    await test('席位重建会话：清掉能点的那几样，但别把侧栏那一行抹白', async () => {
      /**
       * `sum` 现在归名单通道管，而通道只在**变化时**发帧。整个换成空的等于把侧栏那一行
       * 抹白，然后要等这颗 Bot 下次开口才回得来——而换版重启恰恰是人最想从名单上看出
       * 「谁回来了」的时候。
       *
       * 但能点的那几样必须清：它们记的是**这条会话**上还等着人处理的东西，会话都换了，
       * 终态事件永远不会来，留着就是一颗永远灭不掉的「在等你」。
       */
      const ui = await boot(adminToken)
      const row = ui.botStreamOf('bot-restart')
      row.sum.lastText = '上一句话'
      row.sum.lastAt = 123
      row.sum.asks = new Map([['c1', { callId: 'c1' }]])
      row.sum.busy = true
      ui.settleDot(row.sum)
      assert(row.sum.state === 'review', `前置没成立：${row.sum.state}`)

      ui.resetBotStream(row)

      assert(row.sum.lastText === '上一句话', '摘要被抹白了——通道只发变化，这一行要等下次开口才回来')
      assert(row.sum.lastAt === 123, '时间被抹掉了')
      assert(!row.sum.asks || row.sum.asks.size === 0, '旧会话的确认还留着——那颗「在等你」永远灭不掉')
      assert(row.sum.state === 'idle', `状态没重算：${row.sum.state}`)
    })

    await test('追平集重建出来的名单状态，和一路听下来的一模一样', async () => {
      /**
       * 一套上游按账号共享之后，**每一次刷新都是「中途接上」**：新页面连上来时，之前
       * 那些帧早就发过了。管家为此留了一份追平集（manager/src/roster-filter.ts 的 CatchUp），
       * 先补发再转直播。
       *
       * 这个测把两条路摆在一起跑：一路把全部帧喂给客户端（相当于一直连着的那个页面），
       * 另一路只喂追平集（相当于刷新之后接上的页面），**折出来的 sum 必须一致**。
       * 不一致的后果很具体——刷新之后侧栏那颗点、那行摘要、那个「在等你」的角标，会和
       * 没刷新的另一个标签页显示得不一样，而没有任何东西会来纠正它。
       */
      const ui = await boot(adminToken)
      const seq = (botId) => [
        { type: 'roster/ev', botId, ev: { type: 'user/message', seq: 1, time: 100, data: { message: { content: [{ type: 'text', text: '去查一下' }] } } } },
        { type: 'roster/ev', botId, ev: { type: 'turn/start', seq: 2, time: 101, data: { turn: 1 } } },
        { type: 'roster/ev', botId, ev: { type: 'human/handoff', seq: 3, time: 102, data: { id: 'h1', state: 'open' } } },
        { type: 'roster/ev', botId, ev: { type: 'human/handoff', seq: 4, time: 103, data: { id: 'h1', state: 'done' } } },
        // h2 **不收口**：留着才验得到「追平集真的把还开着的那张单带过去了」。只放 h1
        // 那种开了又关的话，两条路都是「没有单」，留存整个坏掉也测不出来。
        { type: 'roster/ev', botId, ev: { type: 'human/handoff', seq: 5, time: 104, data: { id: 'h2', state: 'open' } } },
        { type: 'roster/ev', botId, ev: { type: 'assistant/message', seq: 6, time: 105, data: { message: { content: [{ type: 'text', text: '查完了' }] } } } },
        // 折过的 chunk tick：一轮跑着的时候它是唯一在推「最近活动」那个钟的东西。
        // 序列里必须有它，否则这条等价保证盖不到「刷新之后钟倒退」那个毛病。
        { type: 'roster/ev', botId, ev: { type: 'assistant/chunk', seq: 7, time: 110 } },
        { type: 'roster/ev', botId, ev: { type: 'turn/end', seq: 8, time: 111, data: { turn: 1 } } },
        { type: 'roster/live', botId, live: false },
      ]
      const shot = (botId) => {
        const sum = ui.botStreamOf(botId).sum
        return JSON.stringify({ state: sum.state, need: sum.need, lastText: sum.lastText, lastAt: sum.lastAt })
      }

      // 一直连着的那个页面：每一帧都收到了。
      for (const f of seq('bot-live')) ui.noteRosterFrame(f)

      // 刷新之后接上的页面：只收到追平集。
      const cu = newCatchUp()
      for (const f of seq('bot-catch')) remember(cu, f)
      for (const f of catchUpFrames(new Map([['bot-catch', cu]]))) ui.noteRosterFrame(f)

      assert(shot('bot-live') === shot('bot-catch'), `追平和直播折出来不一样：\n  直播 ${shot('bot-live')}\n  追平 ${shot('bot-catch')}`)
      // 顺带钉住这一份到底该长什么样，免得两边一起错还判成「一致」。
      const sum = ui.botStreamOf('bot-catch').sum
      assert(sum.state === 'review' && sum.need === 'handoff', `那颗点该是「在等人接手」，实际 ${sum.state}/${sum.need}`)
      assert(sum.lastText === '查完了', `摘要不对：${JSON.stringify(sum.lastText)}`)
      assert(sum.lastAt === 110, `「最近活动」该停在那条 tick 上，实际 ${sum.lastAt}`)
    })

    await test('名单一条通道管所有 Bot：十几个 Bot 也只开一条连接', async () => {
      /**
       * 这里以前是**一个 Bot 一条 SSE**，两笔代价都很重：
       *
       * · 连接槽——HTTP/1.1 下浏览器每个源只给 6 条，而 SSE 是永不结束的 fetch，开着
       *   就占死一条。十几个 Bot 把槽占光，画出正文的那条 history 排在后面干等，刷新
       *   一次十几秒才见到消息，而且每次不一样（谁抢到槽是随机的）。
       * · token 洪流——那几条流拿的是全量事件，包括每个 token 一条的 chunk。
       *
       * 现在由席位机器上的管家扇入，浏览器只连一条（过滤规则另有 e2e/roster-stream.mjs
       * 钉着），地址是 `/runtime/bots` 给的 `rosterStreamUrl`——Gateway 上没有这条路了，
       * 所以没给地址时前端根本不该开流。这个测钉住浏览器这一头的两件事：**只开一条**，
       * 以及**那一条真的把每个 Bot 的状态喂进了名单**——十几个 Bot 都要看得见状态变化，
       * 靠的就是它。
       */
      const streams = []
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path, init) => {
          if (path.includes('/roster/stream')) {
            const sse = fakeSse()
            streams.push(sse)
            return sse.response
          }
          return fetch(gwBase + path, init)
        },
      })
      await ui.boot()
      const ids = Array.from({ length: 15 }, (_, i) => 'bot-' + i)
      ui.state.runtimeBots = ids.map((id) => ({ id, name: id.toUpperCase() }))
      try {
        // 这套 e2e 里的机器没配直连地址，名册不会带 rosterStreamUrl；先钉住「没地址就不开」，
        // 再喂一条像样的直连地址进去看它只开一条。
        ui.stopRosterStream()
        streams.length = 0
        ui.state.rosterStreamUrl = ''
        void ui.startRosterStream()
        await new Promise((r) => setTimeout(r, 50))
        assert(streams.length === 0, `没有直连地址还去连了 ${streams.length} 条——Gateway 上早没这条路了`)

        ui.state.rosterStreamUrl = 'https://m001.satuwork.test/roster/stream'
        void ui.startRosterStream()
        for (let i = 0; i < 100 && !streams.length; i++) await new Promise((r) => setTimeout(r, 5))
        assert(streams.length === 1, `15 个 Bot 开了 ${streams.length} 条连接——回到一个 Bot 一条那套了`)

        // 再叫一次也不该再开一条：整页重绘、切页、切 Bot 都会走到那句 startRosterStream。
        void ui.startRosterStream()
        await new Promise((r) => setTimeout(r, 20))
        assert(streams.length === 1, `重复调用又开了一条：${streams.length}`)

        // 每个 Bot 的状态都要能经这一条喂进名单。挑最后一个——它正是「一个 Bot 一条
        // 流」时代最先被上限挡在外面、看不到状态的那一批。
        const last = ids[ids.length - 1]
        streams[0].push({ type: 'roster/ev', botId: last, ev: { type: 'turn/start', seq: 1, time: 1 } })
        streams[0].push({
          type: 'roster/ev',
          botId: last,
          ev: { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: '干完了' }] } } },
        })
        for (let i = 0; i < 100 && !ui.botStreamOf(last).sum.lastText; i++) await new Promise((r) => setTimeout(r, 5))
        const sum = ui.botStreamOf(last).sum
        assert(sum.lastText === '干完了', `第 15 个 Bot 的摘要没喂进来：${JSON.stringify(sum.lastText)}`)
        assert(sum.state === 'busy', `turn/start 之后那颗点该是「正在执行」，实际 ${sum.state}`)

        // 席位表的态压过扫出来的结论——席位崩在半路时日志里有 turn/start 没 turn/end，
        // 只扫事件的话那颗点会永远转下去。
        streams[0].push({ type: 'roster/live', botId: last, live: false })
        for (let i = 0; i < 100 && ui.botStreamOf(last).sum.state === 'busy'; i++) await new Promise((r) => setTimeout(r, 5))
        assert(ui.botStreamOf(last).sum.state !== 'busy', 'roster/live 说没在跑，那颗点还转着')

        // **名单的帧绝不能进事件桶**：它是过滤过的，凑不成一条会话，进了的话点进那个
        // Bot 会看到一段缺了正文的历史。
        assert(ui.botStreamOf(last).events.length === 0, '名单的帧落进事件桶了——点进去会看到缺了正文的历史')
      } finally {
        ui.stopRosterStream()
        for (const s of streams) s.close()
        ui.stopChatStream()
      }
    })

    await test('侧栏预热流先到：认领它，别让正文空着', async () => {
      const sse = fakeSse()
      let release = null
      const held = new Promise((r) => {
        release = r
      })
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/events')) return sse.response
          if (path.includes('/session')) {
            await held
            return { ok: true, status: 200, text: async () => JSON.stringify({ sessionId: 's-a' }) }
          }
          return fetch(gwBase + path)
        },
      })
      await ui.boot()

      // 同一条会话可能有两个人去开流：某条重连路径先把流建上——那会儿它还不是当前会话，
      // chatStreamId 没设——ensureChatSession 随后才把这条会话认成当前的。
      const pending = ui.ensureChatSession('bot-a')
      await new Promise((r) => setTimeout(r, 10))
      void ui.startChatStream('s-a', 0, 'bot-a')
      await new Promise((r) => setTimeout(r, 10))
      release()
      await pending

      // 认领没做的话，这条流在读循环里会同时满足「是当前会话」和「chatStreamId 对不上」
      // ——那正是「人已经切走了」的判据，它自己收摊，重放到一半的历史再也回不来：正文
      // 空白，切走再切回来还是空白，只能刷新整页。
      sse.push({
        type: 'assistant/message',
        seq: 1,
        time: Date.now(),
        data: { message: { content: [{ type: 'text', text: '历史第一条' }] } },
      })
      for (let i = 0; i < 100 && ui.state.chatEvents.length < 1; i++) await new Promise((r) => setTimeout(r, 5))
      assert(ui.state.chatEvents.length === 1, `预热流把自己判成「已经切走」收摊了，正文空白`)
      ui.stopChatStream()
      sse.close()
    })

    await test('换 Bot：没发出去的草稿跟着各自的 Bot 走', async () => {
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/events')) return sse.response
          if (path.includes('/session')) return { ok: true, status: 200, text: async () => JSON.stringify({ sessionId: 's-' + path.split('/bots/')[1].split('/')[0] }) }
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      await ui.ensureChatSession('bot-a')
      ui.state.chatDraft = '写给 A 的半句话'
      await ui.ensureChatSession('bot-b')
      // 带着 A 的草稿跳到 B，一按回车就发错人了。
      assert(ui.state.chatDraft === '', `切到 B 之后草稿还在：${JSON.stringify(ui.state.chatDraft)}`)
      await ui.ensureChatSession('bot-a')
      assert(ui.state.chatDraft === '写给 A 的半句话', `切回 A 草稿没了：${JSON.stringify(ui.state.chatDraft)}`)
      ui.stopChatStream()
      sse.close()
    })

    await test('正文里的 HTML 被转义，不当标签渲染', async () => {
      const ui = await boot(ownerToken)
      const html = ui.auditTranscript([
        { type: 'user/message', data: { message: { content: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] } } },
      ])
      assert(!html.includes('<img src=x'), '正文里的标签没转义')
      assert(html.includes('&lt;img'), '没走转义')
    })
  } finally {
    gw.kill()
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
