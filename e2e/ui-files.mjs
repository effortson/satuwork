/**
 * 正文里的文件名怎么接回工作区里的文件（chat.js 的 knownFiles / fileCands / fileHits），
 * 外加右栏那棵文件树画出来的 HTML。
 *
 * 不起服务、不连数据库：这几个是纯函数，装进 ui-dom.mjs 那层垫片就能跑。
 *
 * 为什么值得单独钉一条：这条规则是**在散文里认名字**，而它唯一的护栏就是那几条边界
 * 判断——认宽了，一句「更新了报表」会把不相干的字点亮，点开是另一个文件；认窄了，
 * 目录树那一屏又一个都点不动。两头都不会有人报 bug，只会觉得「这功能怪怪的」。
 */
import { join } from 'node:path'
import { loadApp, el, fakeSse } from './ui-dom.mjs'

/** 一份现成的名册：两个目录下各一个文件，外加一个重名的。 */
function knownOf(ui, paths) {
  return ui.knownFiles([
    { tools: [{ name: 'ls', refs: paths.map((p) => ({ path: p, name: p.split('/').pop() })) }] },
  ])
}

export async function runUiFiles({ root, test, assert, log }) {
  log('\n# ui-files')
  const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base: 'http://127.0.0.1:1' })

  /** text 里认出来的那些文件名，按出现顺序。 */
  const hits = (text, paths) => ui.fileHits(text, ui.fileCands(knownOf(ui, paths))).map((h) => h.file.path)

  await test('整条会话攒一份名册：产出、附件、看到的都算', async () => {
    const known = ui.knownFiles([
      { files: [{ path: 'uploads/s-1/单据.pdf', name: '单据.pdf' }] },
      {
        tools: [
          { name: 'write', files: [{ path: '报告.md', name: '报告.md' }] },
          { name: 'ls', refs: [{ path: 'uploads/s-1/图.png', name: '图.png' }] },
        ],
      },
    ])
    assert(known.size === 3, `名册里有 ${known.size} 个`)
    assert(known.get('报告.md').name === '报告.md', '产出没进名册')
    assert(known.get('uploads/s-1/图.png'), 'refs 没进名册')
  })

  await test('完整路径认得出来', async () => {
    const got = hits('详见 uploads/s-1/单据.pdf 里的第二页', ['uploads/s-1/单据.pdf'])
    assert(got.length === 1 && got[0] === 'uploads/s-1/单据.pdf', JSON.stringify(got))
  })

  await test('句子里裸着的文件名也认得出来（中文两边不算词边界）', async () => {
    const got = hits('已生成印尼山火报告2026-08.html，请查收', ['印尼山火报告2026-08.html'])
    assert(got.length === 1, `认了 ${got.length} 个：${JSON.stringify(got)}`)
  })

  await test('目录树里那一行（前面是树线、后面是大小）照样认', async () => {
    const tree = '├── Airchina_A359.pdf   (708 KB)\n└── page-1.png   (961 KB)'
    const got = hits(tree, ['uploads/s-1/Airchina_A359.pdf', 'uploads/s-1/page-1.png'])
    assert(got.length === 2, `认了 ${got.length} 个：${JSON.stringify(got)}`)
  })

  await test('完整路径赢过它自己的文件名，不重复认两次', async () => {
    const got = hits('看 uploads/s-1/单据.pdf', ['uploads/s-1/单据.pdf'])
    assert(got.length === 1, `同一段认了 ${got.length} 次`)
  })

  await test('截一半的不认：a.md 不是 ba.md，报表.xlsx 不是 报表.xlsx.bak', async () => {
    assert(hits('打开 ba.md 看看', ['a.md']).length === 0, 'ba.md 被当成了 a.md')
    assert(hits('备份在 报表.xlsx.bak', ['报表.xlsx']).length === 0, '报表.xlsx.bak 被当成了 报表.xlsx')
    assert(hits('src/lib/a.md 里', ['a.md']).length === 0, '更长路径里的一段被单独认了')
  })

  await test('重名的一律不认——猜中一次不值得赔上指错的那两次', async () => {
    const got = hits('改一下 index.ts', ['src/index.ts', 'lib/index.ts'])
    assert(got.length === 0, `重名还认了：${JSON.stringify(got)}`)
    // 但写全了就还是认得出来。
    const full = hits('改一下 src/index.ts', ['src/index.ts', 'lib/index.ts'])
    assert(full.length === 1 && full[0] === 'src/index.ts', JSON.stringify(full))
  })

  await test('没有扩展名的名字不认：一个叫「报告」的文件不该把每个「报告」都点亮', async () => {
    assert(hits('这份报告写完了', ['报告']).length === 0, '无扩展名的名字被认了')
  })

  await test('读过的文件只认 read 报的那些', async () => {
    const tools = [
      { name: 'read', refs: [{ path: '报告.html', name: '报告.html' }] },
      { name: 'ls', refs: [{ path: '别的.txt', name: '别的.txt' }] },
      { name: 'read', refs: [{ path: '报告.html', name: '报告.html' }] },
    ]
    const reads = ui.readFiles(tools)
    assert(reads.length === 1 && reads[0].path === '报告.html', JSON.stringify(reads))
  })

  await test('文件树把目录和文件画成两种行，文件点开走预览', async () => {
    ui.state.wsDirs = {
      '': {
        entries: [
          { name: 'uploads', path: 'uploads', dir: true, size: 0 },
          { name: '报告.md', path: '报告.md', dir: false, size: 2048 },
        ],
        more: 0,
      },
      uploads: { entries: [{ name: '单据.pdf', path: 'uploads/单据.pdf', dir: false, size: 100 }], more: 0 },
    }
    ui.state.wsOpen = { uploads: true }
    const html = ui.workspacePanel()
    assert(html.includes('data-act="ws-dir" data-path="uploads"'), '目录不是可展开的行')
    assert(html.includes('data-path="uploads/单据.pdf"'), '展开的那一层没画出来')
    assert(html.includes('data-act="chat-preview"'), '文件点开的不是预览')
    assert(html.includes('2.0 KB'), '没标大小')
  })

  await test('新生成的 HTML 自动打开，后续 patch 自动刷新且保留预览模式', async () => {
    const calls = []
    let source = '<h1>第一版</h1>'
    const preview = loadApp({
      appPath: join(root, 'gateway/ui/app.js'),
      base: 'http://127.0.0.1:1',
      fetchImpl: async (path) => {
        calls.push(path)
        return new Response(source, {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(Buffer.byteLength(source)),
          },
        })
      },
    })
    preview.state.me = { account: { id: 'a1', role: 'member', email: 'a@b.c' } }
    preview.state.path = '/chat'
    preview.state.chatBotId = 'b1'
    preview.state.chatSessionId = 's-preview'
    preview.state.chatEvents = []
    const event = (turn) => ({
      type: 'tool/result',
      data: { turn, files: [{ path: 'reports/eth.html', name: 'eth.html' }] },
    })

    assert(preview.maybeLivePreview(event(1)), '第一次 HTML 产出没有触发预览')
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert(preview.state.preview?.text === '<h1>第一版</h1>', `预览内容不对：${preview.state.preview?.text}`)
    preview.state.preview.mode = 'source'
    source = '<h1>第二版</h1>'
    assert(preview.maybeLivePreview(event(1)), '同一路径的 patch 没有触发刷新')
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert(preview.state.preview?.text === '<h1>第二版</h1>', '刷新后仍是旧内容')
    assert(preview.state.preview?.mode === 'source', '自动刷新把用户选的源码模式重置了')
    assert(calls.length === 2, `实际拉取了 ${calls.length} 次`)

    // 模拟人主动关掉：同一轮后续 patch 不应再抢着弹回来；下一轮重新生成则可以。
    preview.state.preview = null
    assert(!preview.maybeLivePreview(event(1)), '同一轮关闭后又自动弹回来了')
    assert(preview.maybeLivePreview(event(2)), '下一轮重新生成同一路径没有再次打开')
  })

  /**
   * Office 文档预览：先要席位渲染好的 PDF，要不到退回提取文本。
   * `pdf` 决定 as=pdf 那条怎么答：'ok' 回真 PDF、'old' 学老席位把原文件字节原样回来、
   * 数字就回那个状态码。
   */
  const officePreview = ({ pdf, text = { status: 200, body: { text: '正文', note: '' } } }) => {
    const calls = []
    const app = loadApp({
      appPath: join(root, 'gateway/ui/app.js'),
      base: 'http://127.0.0.1:1',
      fetchImpl: async (path) => {
        calls.push(path)
        const as = new URL(path, 'http://x').searchParams.get('as')
        if (as === 'pdf') {
          if (pdf === 'ok') return new Response('%PDF-1.4 fake', { status: 200, headers: { 'content-type': 'application/pdf' } })
          if (pdf === 'old') return new Response('PK raw docx', { status: 200, headers: { 'content-type': 'application/octet-stream' } })
          return new Response(JSON.stringify({ error: 'x' }), { status: pdf, headers: { 'content-type': 'application/json' } })
        }
        if (as === 'text') {
          return new Response(JSON.stringify(text.body), { status: text.status, headers: { 'content-type': 'application/json' } })
        }
        return new Response('PK raw docx', { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': '11' } })
      },
    })
    app.state.me = { account: { id: 'a1', role: 'member', email: 'a@b.c' } }
    app.state.path = '/chat'
    app.state.chatSessionId = 's-doc'
    app.state.chatEvents = []
    return { app, calls, asOf: (v) => calls.filter((c) => c.includes('as=' + v)).length }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

  await test('Office 预览：有 PDF 就看 PDF，「原文」页用到时才去提取', async () => {
    const { app, asOf } = officePreview({ pdf: 'ok' })
    await app.openPreview('reports/q2.docx', 'q2.docx')
    await settle()
    const p = app.state.preview
    assert(p.kind === 'doc' && p.url && !p.docLoading, `PDF 没接上：${JSON.stringify({ ...p, abort: undefined })}`)
    const html = app.previewModal()
    assert(html.includes('sw-preview-frame') && html.includes(p.url), '没画成 PDF 阅读器')
    assert(html.includes('data-mode="source"'), '有 PDF 时该有「原文」页签')
    // 大多数人只看渲染出来的那份，不该顺手把文本也提一遍。
    assert(asOf('text') === 0, '没切「原文」就去提取了')
    app.setPreviewMode('source')
    await settle()
    assert(asOf('text') === 1 && app.state.preview.text === '正文', `切「原文」没取到文本：${app.state.preview.text}`)
    app.setPreviewMode('view')
    app.setPreviewMode('source')
    await settle()
    assert(asOf('text') === 1, '来回切又提取了一遍')
  })

  await test('Office 预览：老席位（回原文件字节）和没装 LibreOffice（501）都退回文本', async () => {
    for (const pdf of ['old', 501]) {
      const { app, asOf } = officePreview({ pdf })
      await app.openPreview('reports/q2.xlsx', 'q2.xlsx')
      await settle()
      const p = app.state.preview
      // 把 octet-stream 当 PDF 塞给阅读器只会是一片解析失败。
      assert(!p.url, `${pdf}：不是 PDF 的东西被当成 PDF 了`)
      assert(p.mode === 'source' && p.text === '正文' && asOf('text') === 1, `${pdf}：没退回文本：${JSON.stringify({ ...p, abort: undefined })}`)
      assert(!app.previewModal().includes('data-mode="view"'), `${pdf}：没 PDF 还摆着「预览」页签`)
    }
  })

  await test('Office 预览：老格式转不了 PDF 也提取不了，说清楚原因', async () => {
    const { app } = officePreview({ pdf: 501, text: { status: 415, body: { error: '这种格式没法提取成文本' } } })
    await app.openPreview('old/budget.xls', 'budget.xls')
    await settle()
    const html = app.previewModal()
    assert(html.includes('没法提取成文本'), `没说原因：${html.slice(0, 400)}`)
    assert(!html.includes('要更新 Bot 版本'), '把「格式不支持」说成了「席位太老」')
  })

  await test('列不出来时说出来，不画成一棵空树', async () => {
    ui.state.wsDirs = { '': { entries: null, error: '实例还没接上' } }
    ui.state.wsOpen = {}
    assert(ui.workspacePanel().includes('实例还没接上'), '错误被吞掉了')
  })

  await test('截断说出来', async () => {
    ui.state.wsDirs = { '': { entries: [{ name: 'a.md', path: 'a.md', dir: false, size: 1 }], more: 7 } }
    ui.state.wsOpen = {}
    assert(/还有 7 条/.test(ui.workspacePanel()), '少列了几条却没说')
  })

  /**
   * 头一回点开那个文件夹，看到的必须是这台席位里真有的东西。
   *
   * 这两条钉的是同一件事的两头：**「没取到」不能长得像「里面没东西」**，而「这一趟没
   * 取成」也不能就此定格。原先两头都破：进页面那会儿席位还没接上，那一屏当场拿到一句
   * 「实例还没接上」并且**把它当成取过了**——十几秒后席位接上、对话都能发了，那一屏
   * 还停在原地，只有人自己去按那颗刷新才会出来。
   */
  const seatUi = ({ workspace, fail }) => {
    const calls = []
    const fetchImpl = async (path) => {
      calls.push(path)
      // fail：这台席位头 N 趟先摆一个状态码出来（热身中的 503、旧版本的 404）；
      // status 给 0 就是**根本没出门**——Gateway 在重启、网断了一秒，fetch 自己 reject。
      if (fail && path.includes('/workspace') && calls.length <= fail.times) {
        if (!fail.status) throw new TypeError('Failed to fetch')
        return new Response(JSON.stringify({ error: fail.error || '实例还没上线' }), {
          status: fail.status,
          headers: { 'content-type': 'application/json' },
        })
      }
      const body = path.includes('/workspace') ? workspace : {}
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const app = loadApp({
      appPath: join(root, 'gateway/ui/app.js'),
      base: 'http://127.0.0.1:1',
      fetchImpl,
      stubIds: ['chat-thread'],
    })
    app.state.me = { account: { id: 'a1', role: 'member', email: 'a@b.c' } }
    app.state.path = '/chat'
    app.state.chatBotId = 'b1'
    app.state.chatEvents = []
    app.state.chatSessionId = ''
    return { app, calls }
  }

  /** 点开右栏那一屏（走真的点击分发），再让排在后面那一拍跑完。 */
  const openFiles = async (app) => {
    await app.fire('click', el('button', { 'data-act': 'aside-tab', 'data-tab': 'files' }))
    await new Promise((r) => setTimeout(r, 5))
  }

  await test('席位接上之后那一屏自己重取一遍，不用人去按刷新', async () => {
    const { app, calls } = seatUi({ workspace: { entries: [{ name: '报表', path: '报表', dir: true, size: 0 }], more: 0 } })
    app.render()
    await openFiles(app)
    assert(/实例还没接上/.test(app.workspacePanel()), '席位没接上却没说出来')
    assert(calls.length === 0, `会话都没有还发了请求：${JSON.stringify(calls)}`)
    // 席位接上了：走的是 hydrateChat / 流那条路，只 paintChat，不整页重绘。
    app.state.chatSessionId = 's1'
    app.paintChat()
    await new Promise((r) => setTimeout(r, 5))
    assert(calls.some((p) => p.includes('/workspace')), '接上之后没有自己去取')
    assert(/报表/.test(app.workspacePanel()), `那一屏还停在旧状态：${app.workspacePanel()}`)
  })

  await test('席位还在热身（5xx）：过一会儿自己再来一趟', async () => {
    const { app, calls } = seatUi({
      workspace: { entries: [{ name: '报表', path: '报表', dir: true, size: 0 }], more: 0 },
      fail: { status: 503, times: 1 },
    })
    app.state.chatSessionId = 's1'
    app.render()
    await openFiles(app)
    assert(/实例还没上线/.test(app.workspacePanel()), `没把席位那句话说出来：${app.workspacePanel()}`)
    // 到点了（十秒在测里等不起，直接把闹钟拨到现在）。
    app.state.wsDirs[''].retryAt = 1
    app.paintChat()
    await new Promise((r) => setTimeout(r, 5))
    assert(calls.filter((p) => p.includes('/workspace')).length === 2, `没有自己再来一趟：${JSON.stringify(calls)}`)
    assert(/报表/.test(app.workspacePanel()), `重来那一趟没画出来：${app.workspacePanel()}`)
  })

  await test('席位版本旧（404）：说清楚要更新，而且不再自己重试', async () => {
    const { app, calls } = seatUi({
      workspace: {},
      fail: { status: 404, times: 99, error: 'unknown endpoint' },
    })
    app.state.chatSessionId = 's1'
    app.render()
    await openFiles(app)
    assert(/更新 Bot 版本/.test(app.workspacePanel()), `没说清楚是版本旧了：${app.workspacePanel()}`)
    assert(!app.state.wsDirs[''].retryAt, '答案不会变的那种也排了重试')
    app.paintChat()
    await new Promise((r) => setTimeout(r, 5))
    assert(calls.filter((p) => p.includes('/workspace')).length === 1, `打了一台已经把话说清楚的席位：${JSON.stringify(calls)}`)
  })

  await test('压根没走到 Gateway（网断了）：说人话，而且照样排下一趟', async () => {
    const { app, calls } = seatUi({
      workspace: { entries: [{ name: '报表', path: '报表', dir: true, size: 0 }], more: 0 },
      fail: { status: 0, times: 1 },
    })
    app.state.chatSessionId = 's1'
    app.render()
    await openFiles(app)
    const html = app.workspacePanel()
    assert(!/Failed to fetch/.test(html), `把浏览器那句原话摆给人看了：${html}`)
    assert(/连不上服务器/.test(html), `没说清楚是连不上：${html}`)
    assert(app.state.wsDirs[''].retryAt, '最该重来的一种反而没排重试')
    app.state.wsDirs[''].retryAt = 1
    app.paintChat()
    await new Promise((r) => setTimeout(r, 5))
    assert(/报表/.test(app.workspacePanel()), `网回来了却没自己再取一遍：${app.workspacePanel()}`)
    assert(calls.filter((p) => p.includes('/workspace')).length === 2, JSON.stringify(calls))
  })

  await test('换人登录：上一个账号的文件名一个都不许留在树上', async () => {
    const { app } = seatUi({ workspace: { entries: [{ name: '裁员名单.xlsx', path: '裁员名单.xlsx', dir: false, size: 9 }], more: 0 } })
    app.state.chatSessionId = 's1'
    app.render()
    await openFiles(app)
    assert(/裁员名单/.test(app.workspacePanel()), '前置条件没成立：树没取到')
    await app.fire('click', el('button', { 'data-act': 'logout' }))
    assert(!/裁员名单/.test(app.workspacePanel()), `登出之后上一个人的文件名还在：${app.workspacePanel()}`)
    assert(!app.state.wsSession, 'wsSession 没跟着归零')
  })

  /**
   * 树上那颗删除。
   *
   * 这一组盯的是**「点一下」和「真的删了」之间那道确认**，以及删完之后手上那棵树还
   * 对不对得上：工作区没有回收站，删错一次找不回来，而这颗按钮就贴在「点开预览」
   * 那一行的末尾。
   */
  const delUi = ({ workspace, status, error } = {}) => {
    const calls = []
    const fetchImpl = async (path, init) => {
      const method = (init && init.method) || 'GET'
      calls.push(`${method} ${path}`)
      if (method === 'DELETE') {
        return new Response(JSON.stringify(status ? { error: error || '文件不存在' } : { path: '报告.md' }), {
          status: status || 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      const body = path.includes('/workspace') ? workspace : {}
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const app = loadApp({
      appPath: join(root, 'gateway/ui/app.js'),
      base: 'http://127.0.0.1:1',
      fetchImpl,
      stubIds: ['chat-thread'],
    })
    app.state.me = { account: { id: 'a1', role: 'member', email: 'a@b.c' } }
    app.state.path = '/chat'
    app.state.chatBotId = 'b1'
    app.state.chatEvents = []
    app.state.chatSessionId = 's1'
    return { app, calls }
  }

  const delBtn = (path, name, dir) =>
    el('button', { 'data-act': 'ws-del', 'data-path': path, 'data-name': name, 'data-dir': dir ? '1' : '' })

  await test('每一行末尾都有一颗删除，而且它不在行那颗按钮里面', async () => {
    const { app } = delUi({ workspace: {} })
    app.state.wsDirs = {
      '': {
        entries: [
          { name: 'uploads', path: 'uploads', dir: true, size: 0 },
          { name: '报告.md', path: '报告.md', dir: false, size: 2048 },
        ],
        more: 0,
      },
    }
    app.state.wsOpen = {}
    const html = app.workspacePanel()
    assert(/data-act="ws-del"[\s\S]{0,80}data-path="uploads"/.test(html), '目录那一行没有删除')
    assert(/data-act="ws-del"[\s\S]{0,80}data-path="报告.md"/.test(html), '文件那一行没有删除')
    // 按钮套按钮是非法 HTML，浏览器会把里层那颗拎出去——真出来的 DOM 里它就不在
    // 行里了，点谁都是外面那一下。所以删除必须画在行**后面**，不在它体内。
    const row = html.indexOf('data-act="chat-preview"')
    const close = html.indexOf('</button>', row)
    const del = html.search(/data-act="ws-del"[\s\S]{0,80}data-path="报告\.md"/)
    assert(row > 0 && del > close, '删除被画进了行那颗按钮里面')
  })

  await test('点一下删除只弹框，不删；确认之后才真的发出去', async () => {
    const { app, calls } = delUi({ workspace: { entries: [], more: 0 } })
    app.render()
    await app.fire('click', delBtn('报告.md', '报告.md', false))
    assert(app.state.confirm && app.state.confirm.kind === 'ws-del', '点一下就直接删了，没有确认')
    assert(/报告\.md/.test(app.state.confirm.body), `确认框里没写清楚删的是哪个：${app.state.confirm.body}`)
    assert(!calls.some((c) => c.startsWith('DELETE')), `还没确认就发出去了：${JSON.stringify(calls)}`)
    await app.runConfirm()
    const del = calls.find((c) => c.startsWith('DELETE'))
    assert(del && del.includes('path=%E6%8A%A5%E5%91%8A.md'), `删的不是那个文件：${JSON.stringify(calls)}`)
    assert(del.includes('/runtime/sessions/s1/workspace'), `路径不对：${del}`)
    // 删完要重取上一层，不然那一行还在树上——而它已经不存在了，点开是 404。
    assert(calls.filter((c) => c.startsWith('GET') && c.includes('/workspace')).length >= 1, `删完没重取：${JSON.stringify(calls)}`)
  })

  await test('确认框把目录的后果说全：连里面的东西一起没', async () => {
    const { app } = delUi({ workspace: { entries: [], more: 0 } })
    app.render()
    await app.fire('click', delBtn('uploads', 'uploads', true))
    const body = app.state.confirm.body
    assert(/底下的所有文件/.test(body), `目录那句没说清楚会连里面一起删：${body}`)
  })

  await test('删掉目录之后，手上缓存的它和它底下那几层一起扔掉', async () => {
    const { app } = delUi({ workspace: { entries: [], more: 0 } })
    app.state.wsDirs = {
      '': { entries: [{ name: 'uploads', path: 'uploads', dir: true, size: 0 }], more: 0 },
      uploads: { entries: [{ name: '单据.pdf', path: 'uploads/单据.pdf', dir: false, size: 1 }], more: 0 },
      'uploads/旧': { entries: [], more: 0 },
    }
    app.state.wsOpen = { uploads: true, 'uploads/旧': true }
    app.render()
    await app.fire('click', delBtn('uploads', 'uploads', true))
    await app.runConfirm()
    // 留着的话，下次谁建了个同名目录再展开，看到的是上一份内容——那些文件早就不在了。
    assert(!app.state.wsDirs.uploads && !app.state.wsDirs['uploads/旧'], `旧内容还留在手上：${JSON.stringify(Object.keys(app.state.wsDirs))}`)
    assert(!app.state.wsOpen.uploads && !app.state.wsOpen['uploads/旧'], '展开状态没跟着扔掉')
  })

  await test('那个东西本来就不在了（404）：不当失败说', async () => {
    const { app } = delUi({ workspace: { entries: [], more: 0 }, status: 404 })
    app.render()
    await app.fire('click', delBtn('报告.md', '报告.md', false))
    await app.runConfirm()
    // 人要的结果已经成立。摆一句红字只会让他以为还得再删一次。
    assert(!app.state.error, `已经不在了却报成失败：${app.state.error}`)
    assert(/已经不在了/.test(app.state.notice || ''), `没说清楚发生了什么：${app.state.notice}`)
  })

  /**
   * 「刷新正取着这一层」和「把这一层删掉」撞在一起。
   *
   * 会话在这种情况下一动不动，所以那道「换过会话就不作数」的判据一点忙都帮不上：
   * 在途那一趟回来，会把刚删掉的那份内容原样写回缓存。当时看不见——那一行已经从
   * 上一层里消失了——直到 Bot 又建出一个同名目录（每传一个附件都会建
   * `uploads/<sessionId>`），展开它看到的是上一茬的文件，点开全是「文件不存在」。
   */
  await test('刷新正取着这一层时把它删掉：那一趟回来不许把它写回去', async () => {
    let release = () => {}
    const held = new Promise((r) => {
      release = r
    })
    const calls = []
    const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchImpl = async (path, init) => {
      const method = (init && init.method) || 'GET'
      calls.push(`${method} ${path}`)
      if (method === 'DELETE') return reply({ path: 'uploads', dir: true })
      // uploads 那一趟卡在半路上，等这条测里放行。
      if (path.includes('path=uploads')) {
        await held
        return reply({ entries: [{ name: '单据.pdf', path: 'uploads/单据.pdf', dir: false, size: 1 }], more: 0 })
      }
      // 根：删完之后它是空的。
      return reply({ entries: [], more: 0 })
    }
    const app = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base: 'http://127.0.0.1:1', fetchImpl, stubIds: ['chat-thread'] })
    app.state.me = { account: { id: 'a1', role: 'member', email: 'a@b.c' } }
    app.state.path = '/chat'
    app.state.chatBotId = 'b1'
    app.state.chatEvents = []
    app.state.chatSessionId = 's1'
    app.state.wsDirs = {
      '': { entries: [{ name: 'uploads', path: 'uploads', dir: true, size: 0 }], more: 0 },
      uploads: { entries: [{ name: '单据.pdf', path: 'uploads/单据.pdf', dir: false, size: 1 }], more: 0 },
    }
    app.state.wsOpen = { uploads: true }
    app.render()
    // 刷新：根和展开着的那几层一起重取，uploads 那一趟卡住不回。
    const refreshing = app.fire('click', el('button', { 'data-act': 'ws-refresh' }))
    await new Promise((r) => setTimeout(r, 5))
    // 就在这会儿把 uploads 删掉。
    await app.fire('click', delBtn('uploads', 'uploads', true))
    await app.runConfirm()
    assert(!app.state.wsDirs.uploads, `删完缓存里还留着：${JSON.stringify(Object.keys(app.state.wsDirs))}`)
    // 在途那一趟这才回来。
    release()
    await refreshing
    await new Promise((r) => setTimeout(r, 5))
    assert(!app.state.wsDirs.uploads, '在途那一趟把删掉的那一层又写回来了')
    assert(!app.state.wsOpen.uploads, '展开状态也被写回来了')
  })

  /**
   * 上一层同理：删的是根底下的一个文件，而刷新那一趟正取着根。
   */
  await test('刷新正取着上一层时删掉一个文件：那一趟回来不许把这一行摆回去', async () => {
    let release = () => {}
    const held = new Promise((r) => {
      release = r
    })
    let rootCalls = 0
    const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchImpl = async (path, init) => {
      const method = (init && init.method) || 'GET'
      if (method === 'DELETE') return reply({ path: '报告.md' })
      rootCalls += 1
      // 头一趟（刷新按下去那一趟）卡住，回的是删之前那份清单。
      if (rootCalls === 1) {
        await held
        return reply({ entries: [{ name: '报告.md', path: '报告.md', dir: false, size: 2 }], more: 0 })
      }
      return reply({ entries: [], more: 0 })
    }
    const app = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base: 'http://127.0.0.1:1', fetchImpl, stubIds: ['chat-thread'] })
    app.state.me = { account: { id: 'a1', role: 'member', email: 'a@b.c' } }
    app.state.path = '/chat'
    app.state.chatBotId = 'b1'
    app.state.chatEvents = []
    app.state.chatSessionId = 's1'
    app.state.wsDirs = { '': { entries: [{ name: '报告.md', path: '报告.md', dir: false, size: 2 }], more: 0 } }
    app.state.wsOpen = {}
    app.render()
    const refreshing = app.fire('click', el('button', { 'data-act': 'ws-refresh' }))
    await new Promise((r) => setTimeout(r, 5))
    await app.fire('click', delBtn('报告.md', '报告.md', false))
    await app.runConfirm()
    release()
    await refreshing
    await new Promise((r) => setTimeout(r, 5))
    const names = (app.state.wsDirs[''].entries || []).map((e) => e.name)
    assert(!names.includes('报告.md'), `删掉的那一行被写回上一层了：${JSON.stringify(names)}`)
  })

  await test('席位版本旧（404 unknown endpoint）：说要更新，别说成「已经不在了」', async () => {
    const { app } = delUi({ workspace: { entries: [], more: 0 }, status: 404, error: 'unknown endpoint' })
    app.render()
    await app.fire('click', delBtn('报告.md', '报告.md', false))
    await app.runConfirm()
    // 认成「已经不在了」的话，人收到一句「删掉了」，刷新一下那个文件却还在。
    assert(/更新 Bot 版本/.test(app.state.error || ''), `没说清楚是版本旧了：${app.state.error} / ${app.state.notice}`)
    assert(!/已经不在了/.test(app.state.notice || ''), '把「这台席位没这条接口」说成了「文件已经不在了」')
  })

  await test('席位还没接上：不发这条删除请求', async () => {
    const { app, calls } = delUi({ workspace: {} })
    app.state.chatSessionId = ''
    app.render()
    await app.fire('click', delBtn('报告.md', '报告.md', false))
    await app.runConfirm()
    assert(!calls.some((c) => c.startsWith('DELETE')), `没有会话还发了删除：${JSON.stringify(calls)}`)
    assert(app.state.error, '什么都没说，人只会以为删掉了')
  })

  await test('席位回的不是一份目录：说列不出来，不能画成「工作区还是空的」', async () => {
    const { app } = seatUi({ workspace: {} })
    app.state.chatSessionId = 's1'
    app.render()
    await openFiles(app)
    const html = app.workspacePanel()
    assert(!/还是空的/.test(html), `没取到却说成了空工作区：${html}`)
    assert(/列不出来/.test(html), `没说出「没取到」：${html}`)
  })

  /**
   * 票过期（Gateway 回 401）走的必须是和「退出登录」同一套拆法。
   *
   * 原先那支只清了票和 state.me：名单流拿着上一个人的票接着连、每帧往侧栏送他那几个 Bot
   * 的摘要；换人在同一个标签页登进来，startRosterStream 见 rosterAbort 还在就直接 return，
   * 新账号的侧栏从此收不到更新。待办和席位通联那两根轮询也还在转。
   */
  await test('登录票过期（401）：名单流断掉、轮询停下、上一个人的草稿和文件树清空', async () => {
    const streams = []
    const app = loadApp({
      appPath: join(root, 'gateway/ui/app.js'),
      base: 'http://127.0.0.1:1',
      token: 'jwt-a',
      fetchImpl: async (path) => {
        if (String(path).includes('/roster/stream')) {
          const sse = fakeSse()
          streams.push(sse)
          return sse.response
        }
        if (path === '/runtime/bots') {
          return new Response(JSON.stringify({ error: '需要登录' }), { status: 401, headers: { 'content-type': 'application/json' } })
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    try {
      app.state.rosterStreamUrl = 'https://m001.satuwork.test/roster/stream'
      void app.startRosterStream()
      for (let i = 0; i < 100 && !streams.length; i++) await new Promise((r) => setTimeout(r, 5))
      assert(streams.length === 1, '前置条件没成立：名单流没开')
      app.startHandoffPoll()
      app.startSeatWatch()
      app.state.chatBotId = 'bot-a'
      app.state.chatSessionId = 's-a'
      app.state.chatDrafts = { 'bot-a': { text: '上一个人打了一半', files: [] } }
      app.state.chatPending = [{ sessionId: 's-a', text: '还没回执' }]
      app.state.wsDirs = { '': { entries: [{ name: '裁员名单.xlsx', path: '裁员名单.xlsx', dir: false, size: 9 }], more: 0 } }
      app.state.wsSession = 's-a'
      app.state.runtimeBots = [{ id: 'bot-a', name: '上一个人的助理' }]

      let threw = false
      await app.api('GET', '/runtime/bots').catch(() => { threw = true })
      assert(threw, '401 没有抛错')
      const live = app.liveHandles()
      assert(!live.rosterAbort, '票过期了名单流还连着——还在往侧栏送上一个人的摘要')
      assert(!live.handoffTimer, '待办轮询还在转')
      assert(!live.seatWatchTimer, '席位通联轮询还在转')
      assert(!app.token(), '票没清')
      assert(Object.keys(app.state.chatDrafts).length === 0, `草稿没清：${JSON.stringify(app.state.chatDrafts)}`)
      assert(app.state.chatPending.length === 0, '待回执的那几条没清')
      assert(!app.state.wsSession && !app.state.wsDirs[''], '上一个人的文件树还在')
      assert(app.state.runtimeBots.length === 0, 'Bot 名单没清')
      assert(app.state.path === '/login' && /过期/.test(app.state.loginError), `没挪到登录页说清楚：${app.state.path} ${app.state.loginError}`)

      // 换人登进来（同一家公司、同一个名单流地址）：名单流得真的重开一条，不能被旧的那条挡住。
      app.setToken('jwt-b')
      void app.startRosterStream()
      for (let i = 0; i < 100 && streams.length < 2; i++) await new Promise((r) => setTimeout(r, 5))
      assert(streams.length === 2, '换人登录之后名单流没重开——新账号的侧栏收不到更新')
    } finally {
      app.stopRosterStream()
      for (const s of streams) s.close()
      app.endSignedIn()
    }
  })

  await test('路上那条拿的是旧票：它的 401 不能把刚登进来的人踢出去', async () => {
    let release = null
    const held = new Promise((r) => { release = r })
    const app = loadApp({
      appPath: join(root, 'gateway/ui/app.js'),
      base: 'http://127.0.0.1:1',
      token: 'jwt-a',
      fetchImpl: async () => {
        await held
        return new Response(JSON.stringify({ error: '需要登录' }), { status: 401, headers: { 'content-type': 'application/json' } })
      },
    })
    const inflight = app.api('GET', '/me').catch(() => {})
    app.setToken('jwt-b')
    release()
    await inflight
    assert(app.token() === 'jwt-b', '旧票的 401 把新登进来的票清掉了')
  })

  /**
   * 桌面端里本地 Bot 的请求改道到 127.0.0.1、拿的是席位票。它回 401 是**它**不认这把票了
   * （重启过、票换过一轮），不是登录过期——原先 api() 分不出来，本地 Bot 一重启就把人登出。
   */
  await test('本地 Bot 回 401：重新要一把席位票、重试一次，不登出', async () => {
    let issued = 0
    let rejectAll = false
    const hits = []
    const app = loadApp({
      appPath: join(root, 'gateway/ui/app.js'),
      base: 'http://127.0.0.1:1',
      token: 'jwt-a',
      desktop: true,
      localBotBridge: {
        status: async () => ({ running: true, port: 41001, workspace: '/w' }),
        start: async () => ({ running: true, port: 41002 }),
      },
      fetchImpl: async (path, init) => {
        const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
        if (path === '/runtime/bots/local-1/local-bootstrap') {
          issued += 1
          return json({ botId: 'local-1', accessToken: `sat_v${issued}` })
        }
        if (String(path).startsWith('http://127.0.0.1:41002/')) {
          const auth = init.headers.authorization
          hits.push(auth)
          return !rejectAll && auth === 'Bearer sat_v2' ? json({ sessionId: 's-local' }) : json({ error: 'unauthorized' }, 401)
        }
        return json({ error: `unexpected ${path}` }, 404)
      },
    })
    await app.overlayLocalRuntime([{ id: 'local-1', name: 'Mac 助手', runtimeKind: 'local' }])
    assert(issued === 1, `前置条件没成立：该先要过一次票，实际 ${issued}`)
    const got = await app.api('GET', '/runtime/bots/local-1/session')
    assert(got && got.sessionId === 's-local', `重试之后没拿到会话：${JSON.stringify(got)}`)
    assert(issued === 2 && hits.join() === 'Bearer sat_v1,Bearer sat_v2', `该换票重试恰好一次：issued=${issued} hits=${hits}`)
    assert(app.token() === 'jwt-a', '本地 Bot 的 401 把人登出了')

    // 换了票还是 401：照普通错误报，仍然不登出，也不无限重试。
    rejectAll = true
    hits.length = 0
    let err = null
    await app.api('GET', '/runtime/bots/local-1/session').catch((e) => { err = e })
    assert(err && err.status === 401, `该抛一个带 401 的普通错误：${err}`)
    assert(hits.length === 2, `只该重试一次：${hits.length}`)
    assert(app.token() === 'jwt-a' && app.state.path !== '/login', '本地 Bot 的 401 把人登出了')
  })
}
