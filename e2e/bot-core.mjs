/**
 * 本机 Bot 套件（从 run.mjs 搬出来的 runBot）：不接 Gateway，只用席位票打 bot 的 /api。
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { skips } from './harness.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// bot 的入站凭据现在**只有**席位票。机器票不再进 bot.env，也不再被 bot 接受——
// 它是管家的 root 控制面凭据，而 bot.env 是席位那个普通 Linux 用户读得到的。
const SEAT_TOK = 'sat_e2e-seat-token'

/**
 * 当前的会话落盘格式版本，直接从源码里读出来。
 *
 * 写死数字的话，每升一版都要来改一遍测试——改着改着就会有人图省事把断言删掉，
 * 而这几条断言恰恰是「迁移真的跑了」的唯一证据。
 */
const SESSION_FORMAT = Number(
  /SESSION_FORMAT_VERSION = (\d+)/.exec(readFileSync(join(root, 'bot/src/session/types.ts'), 'utf8'))?.[1],
)

export async function runBot({ botRoot, botHome: BOT_HOME, botPort: BOT_PORT, test, req, start, waitHttp, assert, log }) {
  log('\n# bot')
  rmSync(BOT_HOME, { recursive: true, force: true })
  const base = `http://127.0.0.1:${BOT_PORT}`
  const child = start('bot', ['--import', 'tsx', join(botRoot, 'e2e-boot.mjs')], {
    cwd: botRoot,
    env: {
      SATUWORK_HOME: BOT_HOME,
      SATUWORK_PORT: String(BOT_PORT),
      // 本机套件：显式关掉 Gateway，避免继承环境里的 GATEWAY_URL 而不种 default。
      // GATEWAY_TOKEN 要给：它是 bot 现在唯一认的入站凭据。catalog 的 configured
      // 同时要 URL 和 token，URL 空着就仍然不去拉目录，照旧种 default。
      GATEWAY_URL: '',
      GATEWAY_TOKEN: SEAT_TOK,
      GATEWAY_API_KEY: '',
      SATUWORK_BOT_ID: '',
      // 钉死「这台机器没有 LibreOffice」：as=pdf 那条要的是确定的 501，不能随开发机装没装而变。
      SATUWORK_SOFFICE: join(BOT_HOME, 'no-soffice'),
      // 空 key 不删：套件不能因为没配模型就整组失败，但进程环境保持原样。
    },
  })
  await waitHttp(base + '/api/health', { timeout: 45000, child, what: 'bot' })
  assert(!child._exited, 'bot 启动后就退出了')

  let botId
  let sessionId

  await test('未登录 /api/bots → 401（不跳过鉴权）', async () => {
    const r = await req(base, 'GET', '/api/bots')
    assert(r.status === 401, `unauth ${r.status} ${r.text}`)
  })

  await test('GET / → JSON 404，不是 HTML SPA', async () => {
    const r = await req(base, 'GET', '/')
    assert(r.status === 404, `root ${r.status} ${r.text}`)
    assert(r.json && r.json.error, `not json ${String(r.text).slice(0, 120)}`)
    assert(!String(r.text).toLowerCase().includes('<html'), '仍发 html')
  })

  await test('席位票 GET /api/bots', async () => {
    const r = await req(base, 'GET', '/api/bots', { token: SEAT_TOK })
    assert(r.status === 200, `machine ${r.status} ${r.text}`)
    assert(Array.isArray(r.json.bots) && r.json.bots.length >= 1, 'empty')
  })

  await test('大小写和尾斜杠都绕不过 /api 守卫', async () => {
    // 路由是 path-to-regexp 编出来的正则，带 `i` 标志、还允许一个尾斜杠；守卫却是
    // 按原样字符串 startsWith('/api/') 判的。两边口径不一致时 `GET /API/bots` 会两头
    // 落空：守卫认为「不是 /api，放行」，路由照样命中——整个 /api 面未鉴权。
    for (const path of ['/API/bots', '/Api/Bots', '/api/bots/', '/API/bots/']) {
      const anon = await req(base, 'GET', path)
      assert(anon.status === 401, `${path} 无票应 401，得到 ${anon.status} ${anon.text}`)
      const ok = await req(base, 'GET', path, { token: SEAT_TOK })
      assert(ok.status === 200, `${path} 有票应 200，得到 ${ok.status} ${ok.text}`)
    }
  })

  await test('bot 里没有账号体系：/api/auth/* 与 /api/me* 一律不通', async () => {
    // 这套东西（用户、邀请、cookie 会话、口令重置）是 Gateway 出现之前那一版的。
    // 它一个调用方都没有，却仍然在监听：`/api/auth/setup` 当时在公开白名单里，
    // 一个用户都没有时谁都能建出第一个 admin——而席位上的员工在 noVNC 桌面里
    // 正好打得到 127.0.0.1:<botPort>，建完就绕开了席位票。
    //
    // 没票时守卫先答 401，带票时路由不存在答 404。两种都行，唯独不能是 200。
    for (const [method, path] of [
      ['GET', '/api/auth/state'],
      ['POST', '/api/auth/setup'],
      ['POST', '/api/auth/login'],
      ['GET', '/api/me'],
      ['GET', '/api/me/sessions'],
      ['GET', '/api/invites/whatever'],
    ]) {
      const anon = await req(base, method, path, { body: method === 'POST' ? {} : undefined })
      assert(anon.status === 401 || anon.status === 404, `${path} 无票应 401/404，得到 ${anon.status}`)
      const withTok = await req(base, method, path, {
        token: SEAT_TOK,
        body: method === 'POST' ? {} : undefined,
      })
      assert(withTok.status === 404, `${path} 带票应 404（路由已删），得到 ${withTok.status} ${withTok.text}`)
    }
  })

  await test('GET /api/bots 无 mock:true，默认 bot 带 provider+model', async () => {
    const r = await req(base, 'GET', '/api/bots', { token: SEAT_TOK })
    assert(r.status === 200, `bots ${r.status} ${r.text}`)
    assert(r.json.mock !== true, '顶层 mock:true')
    assert(Array.isArray(r.json.bots) && r.json.bots.length >= 1, '空名册')
    assert(
      r.json.bots.every((a) => a.mock !== true),
      '条目带 mock:true',
    )
    const def = r.json.bots.find((a) => a.id === 'default') || r.json.bots[0]
    assert(def && def.id, '没有默认 bot')
    assert(def.provider === 'deepseek', `provider ${def.provider}`)
    assert(typeof def.model === 'string' && def.model, '缺 model')
    botId = def.id
  })

  await test('POST /api/bots → 410（Bot 配置在 Gateway）', async () => {
    const r = await req(base, 'POST', '/api/bots', {
      token: SEAT_TOK,
      body: { name: '测试助理', description: 'e2e', prompt: '只说好' },
    })
    assert(r.status === 410 || r.status === 404, `create ${r.status} ${r.text}`)
    if (r.status === 410) assert(String(r.json.error || r.text).includes('Gateway'), '410 文案')
  })

  await test('GET /api/bots/:id/session 二次调用同一 sessionId', async () => {
    const a = await req(base, 'GET', `/api/bots/${botId}/session`, { token: SEAT_TOK })
    assert(a.status === 200, `session1 ${a.status} ${a.text}`)
    assert(typeof a.json.sessionId === 'string' && a.json.sessionId, 'sessionId')
    const b = await req(base, 'GET', `/api/bots/${botId}/session`, { token: SEAT_TOK })
    assert(b.status === 200, `session2 ${b.status}`)
    assert(b.json.sessionId === a.json.sessionId, 'sessionId 变了')
    sessionId = a.json.sessionId
  })

  await test('POST /api/sessions 缺 botId → 400', async () => {
    const r = await req(base, 'POST', '/api/sessions', { token: SEAT_TOK, body: { title: '无主' } })
    assert(r.status === 400, `sessions ${r.status} ${r.text}`)
  })

  // ── 附件：上传进工作区，再原样取回来。────────────────────────────────
  // workspace-files 那一组钉的是服务层的边界，这里钉的是**HTTP 这一跳**：
  // 文件名怎么过 header、字节有没有在路上被改、预览的响应头对不对。
  let uploadedPath

  await test('上传附件：落进工作区，返回相对路径', async () => {
    const bytes = Buffer.from('列,值\n甲,1\n乙,2\n', 'utf8')
    const r = await req(base, 'POST', `/api/sessions/${sessionId}/files`, {
      token: SEAT_TOK,
      raw: bytes,
      headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('二季度.csv') },
    })
    assert(r.status === 200, `upload ${r.status} ${r.text}`)
    assert(typeof r.json.path === 'string' && r.json.path.startsWith('uploads/'), `落点不对：${r.text}`)
    // 中文名要能穿过 header 活着回来——这正是不用查询串、改用 URL 编码 header 的原因。
    assert(r.json.name === '二季度.csv', `文件名坏了：${r.json.name}`)
    assert(r.json.size === bytes.length, `大小对不上：${r.json.size} ≠ ${bytes.length}`)
    uploadedPath = r.json.path
    const onDisk = join(BOT_HOME, 'work', uploadedPath)
    assert(existsSync(onDisk), `磁盘上没有 ${onDisk}`)
    assert(readFileSync(onDisk, 'utf8') === bytes.toString('utf8'), '落盘内容和传上去的不一样')
  })

  await test('上传到不存在的会话 → 404', async () => {
    const r = await req(base, 'POST', '/api/sessions/no-such-session/files', {
      token: SEAT_TOK,
      raw: Buffer.from('x'),
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'a.txt' },
    })
    assert(r.status === 404, `应该 404，实为 ${r.status} ${r.text}`)
  })

  await test('预览：字节一个不差，响应头挡住嗅探', async () => {
    const r = await req(base, 'GET', `/api/workspace/file?path=${encodeURIComponent(uploadedPath)}`, { token: SEAT_TOK })
    assert(r.status === 200, `preview ${r.status} ${r.text}`)
    assert(r.text === '列,值\n甲,1\n乙,2\n', `内容对不上：${JSON.stringify(r.text)}`)
    assert(String(r.headers.get('content-type')).startsWith('text/plain'), `类型不对：${r.headers.get('content-type')}`)
    assert(r.headers.get('x-content-type-options') === 'nosniff', '少了 nosniff，白名单会被嗅探绕过')
    const cd = String(r.headers.get('content-disposition') || '')
    assert(cd.startsWith('inline'), `csv 该能内联：${cd}`)
    // 中文名两份都要在：ASCII 那份兜底，filename* 带原名。
    assert(cd.includes("filename*=UTF-8''"), `少了 RFC 5987 的那份：${cd}`)
  })

  await test('预览：?download=1 强制另存', async () => {
    const r = await req(base, 'GET', `/api/workspace/file?path=${encodeURIComponent(uploadedPath)}&download=1`, { token: SEAT_TOK })
    assert(r.status === 200, `download ${r.status}`)
    assert(String(r.headers.get('content-disposition')).startsWith('attachment'), '没强制另存')
  })

  await test('预览：能带脚本的类型一律另存，不给内联', async () => {
    const r = await req(base, 'POST', `/api/sessions/${sessionId}/files`, {
      token: SEAT_TOK,
      raw: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'evil.svg' },
    })
    assert(r.status === 200, `upload svg ${r.status} ${r.text}`)
    const g = await req(base, 'GET', `/api/workspace/file?path=${encodeURIComponent(r.json.path)}`, { token: SEAT_TOK })
    assert(g.status === 200, `get svg ${g.status}`)
    // 内联一个带 <script> 的 SVG，等于让上传者在这个源上执行代码。
    assert(String(g.headers.get('content-disposition')).startsWith('attachment'), 'SVG 被允许内联了')
    assert(g.headers.get('content-type') === 'application/octet-stream', `SVG 的 MIME 不该是 image/svg+xml：${g.headers.get('content-type')}`)
  })

  await test('预览：路径越界 → 400，文件不存在 → 404', async () => {
    const bad = await req(base, 'GET', `/api/workspace/file?path=${encodeURIComponent('../../../etc/passwd')}`, { token: SEAT_TOK })
    assert(bad.status === 400, `越界应该 400，实为 ${bad.status} ${bad.text}`)
    const missing = await req(base, 'GET', `/api/workspace/file?path=${encodeURIComponent('nope.txt')}`, { token: SEAT_TOK })
    assert(missing.status === 404, `不存在应该 404，实为 ${missing.status} ${missing.text}`)
    const empty = await req(base, 'GET', '/api/workspace/file', { token: SEAT_TOK })
    assert(empty.status === 400, `缺 path 应该 400，实为 ${empty.status}`)
  })

  await test('预览：as=pdf 不认的格式 415，没装 LibreOffice 501（界面据此退回文本）', async () => {
    const csv = await req(base, 'GET', `/api/workspace/file?path=${encodeURIComponent(uploadedPath)}&as=pdf`, { token: SEAT_TOK })
    assert(csv.status === 415, `csv 该 415，实为 ${csv.status} ${csv.text}`)
    const up = await req(base, 'POST', `/api/sessions/${sessionId}/files`, {
      token: SEAT_TOK,
      raw: Buffer.from('PK not really a docx'),
      headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('报告.docx') },
    })
    assert(up.status === 200, `upload docx ${up.status} ${up.text}`)
    const r = await req(base, 'GET', `/api/workspace/file?path=${encodeURIComponent(up.json.path)}&as=pdf`, { token: SEAT_TOK })
    // 501 而不是 500：「这台机器转不了」是预期内的答案，不是故障。
    assert(r.status === 501 && r.json && r.json.reason === 'unavailable', `该 501 unavailable，实为 ${r.status} ${r.text}`)
    const missing = await req(base, 'GET', `/api/workspace/file?path=${encodeURIComponent('nope.docx')}&as=pdf`, { token: SEAT_TOK })
    assert(missing.status === 404, `不存在应该 404，实为 ${missing.status} ${missing.text}`)
  })

  await test('附件这两条路一样要过鉴权', async () => {
    const up = await req(base, 'POST', `/api/sessions/${sessionId}/files`, {
      raw: Buffer.from('x'),
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'a.txt' },
    })
    assert(up.status === 401, `未登录上传 ${up.status}`)
    const get = await req(base, 'GET', `/api/workspace/file?path=${encodeURIComponent(uploadedPath)}`)
    assert(get.status === 401, `未登录预览 ${get.status}`)
  })

  // ── 图片：发进消息里，模型是真能看见的那种。────────────────────────
  let shotPath

  await test('带图发消息：图片块落进 JSONL，存的是路径不是字节', async () => {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
      'hex',
    )
    const up = await req(base, 'POST', `/api/sessions/${sessionId}/files`, {
      token: SEAT_TOK,
      raw: png,
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'shot.png' },
    })
    assert(up.status === 200, `传图 ${up.status} ${up.text}`)
    shotPath = up.json.path

    const r = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, {
      token: SEAT_TOK,
      body: { text: '这张图里是什么', images: [{ path: shotPath, mime: 'image/png' }] },
    })
    assert(r.status === 200, `带图发消息 ${r.status} ${r.text}`)
    assert(r.json.accepted === true || r.json.steered === true || r.json.queued === true, `既没 accepted、steered 也没 queued：${r.text}`)

    await new Promise((x) => setTimeout(x, 800))
    assert(!child._exited, '带图发消息把进程打挂了')

    const file = join(BOT_HOME, 'sessions', `${sessionId}.jsonl`)
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    const withImage = lines.filter(
      (e) => e.type === 'user/message' && (e.data?.message?.content ?? []).some((c) => c.type === 'image'),
    )
    // steer 的消息不写日志（既有行为），所以这条可能没落下来——落下来了就必须是对的。
    if (withImage.length) {
      const block = withImage[0].data.message.content.find((c) => c.type === 'image')
      assert(block.path === shotPath, `图片块路径不对：${block.path}`)
      assert(block.mime === 'image/png', `图片块 mime 不对：${block.mime}`)
      // 一张 2 MB 的图 base64 之后是 2.7 MB，写进 JSONL 会让这一行没法 grep、没法 tail。
      const raw = JSON.stringify(withImage[0])
      assert(!raw.includes(png.toString('base64')), '图片字节被写进会话日志了')
      assert(raw.length < 2000, `事件行 ${raw.length} 字符，太长了，多半是把字节写进去了`)
    }
  })

  await test('图片路径逃不出工作区，也不能指一个不存在的文件', async () => {
    // 路径是浏览器传上来的。这一层不挡，工作区边界就等于没有。
    const escape = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, {
      token: SEAT_TOK,
      body: { text: 'x', images: [{ path: '../../../etc/passwd', mime: 'image/png' }] },
    })
    assert(escape.status === 400, `越界路径应该 400，实为 ${escape.status} ${escape.text}`)

    const missing = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, {
      token: SEAT_TOK,
      body: { text: 'x', images: [{ path: 'nope.png', mime: 'image/png' }] },
    })
    assert(missing.status === 400, `不存在的图应该 400，实为 ${missing.status} ${missing.text}`)
  })

  await test('模型看不了的图片格式当场拒掉', async () => {
    // 不在白名单里的（TIFF、SVG、HEIC）各家 provider 支持不一，发过去多半换回一个
    // 400——而那个 400 长得像我们自己的 bug，查起来要绕一大圈。
    const bad = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, {
      token: SEAT_TOK,
      body: { text: 'x', images: [{ path: shotPath, mime: 'image/svg+xml' }] },
    })
    assert(bad.status === 400, `svg 应该 400，实为 ${bad.status} ${bad.text}`)
    const nomime = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, {
      token: SEAT_TOK,
      body: { text: 'x', images: [{ path: shotPath }] },
    })
    assert(nomime.status === 400, `缺 mime 应该 400，实为 ${nomime.status}`)
  })

  await test('只有图、没有正文也能发', async () => {
    // 「这张图什么意思」本来就常常只有一张图。
    const r = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, {
      token: SEAT_TOK,
      body: { images: [{ path: shotPath, mime: 'image/png' }] },
    })
    assert(r.status === 200, `只带图 ${r.status} ${r.text}`)
    // 但两样都没有仍然要拒——那是一条空消息。
    const empty = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, { token: SEAT_TOK, body: {} })
    assert(empty.status === 400, `空消息应该 400，实为 ${empty.status}`)
  })

  await test('发消息：无 Gateway 密钥也不准把进程打挂；JSONL 根有 botId+origin', async () => {
    const r = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, {
      token: SEAT_TOK,
      body: { text: 'ping' },
    })
    // 只认 200：这条路（bot/src/web/index.ts 的 /messages）收下就回 accepted / steered，
    // 没配模型是那一轮之后的事，HTTP 这一跳不该因此变成 4xx。以前放到 4xx 的写法
    // 等于「随便回什么都行」，验不出任何东西。
    assert(r.status === 200, `message ${r.status} ${r.text}`)
    assert(r.json.accepted === true || r.json.steered === true || r.json.queued === true, '既没 accepted、steered 也没 queued')
    await new Promise((x) => setTimeout(x, 800))
    assert(!child._exited, `发消息后进程退出 code=${child._exited?.code} sig=${child._exited?.sig}`)
    const health = await req(base, 'GET', '/api/health')
    assert(health.status === 200 && health.json.ok === true, 'health 挂了')
    // 管家换 bot 版本之前要问这条路「你忙不忙」（见 manager/src/seats.ts 的排空）。
    // 少了这两个字段，管家只会当成「问不出来」，然后照旧把跑着的那一轮拦腰重启。
    assert(typeof health.json.busy === 'boolean', `/api/health 不报忙闲：${health.text}`)
    assert(
      typeof health.json.running === 'number' && typeof health.json.queued === 'number',
      `/api/health 的计数少了：${health.text}`,
    )

    const file = join(BOT_HOME, 'sessions', `${sessionId}.jsonl`)
    assert(existsSync(file), `没有 JSONL ${file}`)
    const first = readFileSync(file, 'utf8').split('\n').find((l) => l.trim())
    const ev = JSON.parse(first)
    assert(ev.type === 'session', `首条是 ${ev.type}`)
    assert(ev.data.botId === botId, `botId ${ev.data.botId}`)
    assert(ev.data.origin, '缺 origin')
    skips.push('模型回复：bot 不持有上游 key，只断言接口收了、进程还在、JSONL 根字段在')
  })

  await test('每条流的第一帧自报进程身份：换过版的席位认得出来', async () => {
    /**
     * 换版就是把 bot 换一个进程，而浏览器那头只看得见「流断了」——和网络抖一下长得
     * 一模一样。于是它拿着换版前的游标续传、接着用旧进程攒下来的状态（正在跑的那一
     * 轮、排队的 dock、目录里的工具），没有任何东西会来纠正它。
     *
     * **重启信号只有一个时刻送得出去**：进程死掉那一刻它已经说不了话了，只能在重新
     * 连上的第一帧补说一句「我是谁」。所以这一帧必须排在重放之前——重放可能很长，而
     * 客户端要先知道这批事件是接着看还是全部作废。
     */
    // SSE 不会自己结束（心跳一直在），所以读到第一批帧就掐断——`req` 那个助手会一直
    // 等 text() 收完，在这条路上等于挂死。
    const ac = new AbortController()
    const res = await fetch(`${base}/api/sessions/${sessionId}/events?tail=1`, {
      headers: { authorization: 'Bearer ' + SEAT_TOK, accept: 'text/event-stream' },
      signal: ac.signal,
    })
    assert(res.ok, `开流 ${res.status}`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let raw = ''
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !raw.includes('replay/done')) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((ok) => setTimeout(() => ok({ done: true, value: undefined }), 1200)),
      ])
      if (done) break
      raw += dec.decode(value, { stream: true })
    }
    ac.abort()
    const frames = raw
      .split('\n\n')
      .map((f) => f.replace(/^data: /, '').trim())
      .filter(Boolean)
      .map((f) => {
        try {
          return JSON.parse(f)
        } catch {
          return null
        }
      })
      .filter(Boolean)
    assert(frames.length > 0, `一帧都没收到：${raw.slice(0, 200)}`)
    const hello = frames[0]
    assert(hello.type === 'runtime/hello', `第一帧不是自报家门，是 ${hello.type}——排在重放后面就晚了`)
    assert(typeof hello.instanceId === 'string' && hello.instanceId.length >= 8, `没给进程身份：${JSON.stringify(hello)}`)
    assert(typeof hello.startedAt === 'number' && hello.startedAt > 0, `没给起来的时刻：${JSON.stringify(hello)}`)
    // health 上那一份必须是同一个：管家排错时两条路对得上才有用。
    const h = await req(base, 'GET', '/api/health')
    assert(h.json.instanceId === hello.instanceId, `两条路报的身份不一样：${h.json.instanceId} vs ${hello.instanceId}`)
  })

  await test('换版静默：落闸之后不接新一轮，放开之后立刻恢复；无票调不动', async () => {
    /**
     * 管家在重启这个进程之前先落这道闸（见 manager/src/seats.ts 的排空）：等到「此刻
     * 没人在跑」之后，到真的 `systemctl restart` 之间还隔着拉包、解包、rsync 那几秒，
     * 不落闸的话人在那几秒里发一句照样被拦腰砍断。
     *
     * 这一条走的是 HTTP 面，钉的正是「开新一轮之前那道闸」——它必须判在真正要开新一轮
     * 的那一刻，而不是请求刚进来时：steering 落空（那一轮正好跑完）会掉回开新一轮的
     * 路上，早判的话那里就是个缝，`accepted: true` 已经回出去了，消息却一个字没跑。
     */
    const anon = await req(base, 'POST', '/api/quiesce', { body: { ttlMs: 60_000 } })
    assert(anon.status === 401, `静默开关无票该 401，实际 ${anon.status} ${anon.text}`)

    const on = await req(base, 'POST', '/api/quiesce', { token: SEAT_TOK, body: { ttlMs: 60_000 } })
    assert(on.status === 200 && on.json.quiesced === true, `落闸失败：${on.status} ${on.text}`)
    const h = await req(base, 'GET', '/api/health')
    assert(h.json.quiesced === true, `health 该自报静默中：${h.text}`)

    const refused = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, {
      token: SEAT_TOK,
      body: { text: '换版这几秒发的' },
    })
    assert(refused.status === 409, `静默期该当场回绝，实际 ${refused.status} ${refused.text}`)
    assert(String(refused.json.error).includes('换新版本'), `回绝的话说不清：${refused.text}`)

    const off = await req(base, 'POST', '/api/quiesce', { token: SEAT_TOK, body: { ttlMs: 0 } })
    assert(off.status === 200 && off.json.quiesced === false, `放开失败：${off.status} ${off.text}`)
    const again = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, {
      token: SEAT_TOK,
      body: { text: 'ping' },
    })
    assert(again.status === 200, `放开之后该照常收下，实际 ${again.status} ${again.text}`)
    assert(!again.json.quiesced, `放开了还说自己在静默：${again.text}`)
  })

  /**
   * 人手改上下文边界：`/compact` 和 `/new`（见 docs/chat-commands.md）。
   *
   * 这里钉的是**HTTP 面**：要票、拒绝要带得出原话、成功要真的落一条事件。边界怎么挑
   * 是纯函数，由 e2e/compact.mjs 那组管。
   */
  await test('POST /api/sessions/:id/{compact,reset} → 要票，拒绝时说得出原因', async () => {
    for (const act of ['compact', 'reset']) {
      const anon = await req(base, 'POST', `/api/sessions/${sessionId}/${act}`)
      assert(anon.status === 401, `${act} 无票该 401，实际 ${anon.status} ${anon.text}`)
    }

    const file = join(BOT_HOME, 'sessions', `${sessionId}.jsonl`)
    const readLines = () =>
      readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    // 上一条用例放开静默之后补发了一句 ping，那一轮此刻多半还在跑——重置撞上去就是
    // 409「这一轮还在跑」，而这条用例要钉的根本不是那件事。等它跑完再动手。
    for (let i = 0; i < 200 && (await req(base, 'GET', '/api/health')).json.busy; i++) {
      await new Promise((x) => setTimeout(x, 50))
    }

    const before = readLines()
    const ends = before.filter((e) => e.type === 'turn/end')

    const r = await req(base, 'POST', `/api/sessions/${sessionId}/reset`, { token: SEAT_TOK })
    if (!ends.length) {
      // 这条会话一轮都没跑完（上游是假的，跑不跑得完不由这里决定）。那就必须是这句话，
      // 不能是 500——「没有要清的上下文」和「它崩了」在界面上得分得开。
      assert(r.status === 409, `一轮都没跑完时该 409，实际 ${r.status} ${r.text}`)
      assert(String(r.json.error || '').includes('没跑成过一轮'), `话说不清：${r.text}`)
      return
    }

    assert(r.status === 200 && r.json.reset === true, `重置失败：${r.status} ${r.text}`)
    const after = readLines()
    const mark = [...after].reverse().find((e) => e.type === 'session/reset')
    assert(mark, '重置成功了，日志里却没有 session/reset')
    assert(mark.data.throughSeq === r.json.throughSeq, `回给前端的 seq 和落盘的对不上：${r.text}`)
    // **边界必须落在 turn/end 上。** 切在轮次中间会留下无主的 tool/result，
    // provider 直接拒收整个请求——而那要等到下一轮真发出去才炸。
    const at = after.find((e) => e.seq === mark.data.throughSeq)
    assert(at?.type === 'turn/end', `边界落在了 ${at?.type} 上，必须是 turn/end`)
    // **日志一条不删**，这是整件事的前提。
    assert(after.length > before.length, `重置之后日志反而短了：${before.length} → ${after.length}`)

    const twice = await req(base, 'POST', `/api/sessions/${sessionId}/reset`, { token: SEAT_TOK })
    assert(twice.status === 409, `连着点两次该 409，实际 ${twice.status} ${twice.text}`)

    // 刚重置完，边界之后一条完整轮次都没有——压不动，而且要说人话。
    const c = await req(base, 'POST', `/api/sessions/${sessionId}/compact`, { token: SEAT_TOK })
    assert(c.status === 409, `刚重置完该压不动，实际 ${c.status} ${c.text}`)
    assert(String(c.json.error || '').includes('太短'), `压不动的理由说不清：${c.text}`)
  })

  /**
   * `/clear`（docs/chat-commands.md §15）：落的还是 session/reset，多一个 clear 标记；
   * 之前的不再给界面，日志一条不删。接在上面那条后面跑：刚 /new 过，正好钉「/new 之后
   * 紧接着 /clear 要放行」那一条。
   */
  await test('POST /api/sessions/:id/clear → 要票，清完界面只拿得到清除点之后的', async () => {
    const anon = await req(base, 'POST', `/api/sessions/${sessionId}/clear`)
    assert(anon.status === 401, `clear 无票该 401，实际 ${anon.status} ${anon.text}`)

    const file = join(BOT_HOME, 'sessions', `${sessionId}.jsonl`)
    const readLines = () =>
      readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    const before = readLines()
    const r = await req(base, 'POST', `/api/sessions/${sessionId}/clear`, { token: SEAT_TOK })
    if (!before.some((e) => e.type === 'turn/end')) {
      assert(r.status === 409, `一轮都没跑完时该 409，实际 ${r.status} ${r.text}`)
      assert(String(r.json.error || '').includes('没有对话记录'), `话说不清：${r.text}`)
      return
    }
    assert(r.status === 200 && r.json.cleared === true, `/new 之后紧接着 /clear 该放行：${r.status} ${r.text}`)
    const after = readLines()
    const mark = after.at(-1)
    assert(mark.type === 'session/reset' && mark.data.clear === true, `日志里没有带 clear 的重置点：${JSON.stringify(mark)}`)
    assert(mark.data.throughSeq === r.json.throughSeq, `回给前端的 seq 和落盘的对不上：${r.text}`)
    // **日志一条不删**：审计、计费还要用。
    assert(after.length === before.length + 1, `清空之后日志该只多一条：${before.length} → ${after.length}`)

    const h = await req(base, 'GET', `/api/sessions/${sessionId}/history?turns=50`, { token: SEAT_TOK })
    assert(h.status === 200, `history ${h.status} ${h.text}`)
    assert(h.json.events.every((e) => e.seq > mark.data.throughSeq), '清除点之前的事件还在往界面上给')
    assert(h.json.hasMore === false, '清空之后还挂着「加载更早的对话」')

    const twice = await req(base, 'POST', `/api/sessions/${sessionId}/clear`, { token: SEAT_TOK })
    assert(twice.status === 409 && String(twice.json.error || '').includes('已经清空过'), `连着清两次该 409：${twice.status} ${twice.text}`)
    const reset = await req(base, 'POST', `/api/sessions/${sessionId}/reset`, { token: SEAT_TOK })
    assert(reset.status === 409, `清空之后再 /new 该 409：${reset.status} ${reset.text}`)
  })

  await test('GET /api/billing → 404（账单已挪到 Gateway）', async () => {
    const r = await req(base, 'GET', '/api/billing', { token: SEAT_TOK })
    assert(r.status === 404 || r.status === 410, `billing ${r.status} ${r.text}`)
  })

  await test('GET /api/usage → 404（用量统计已挪到 Gateway）', async () => {
    const r = await req(base, 'GET', '/api/usage', { token: SEAT_TOK })
    assert(r.status === 404 || r.status === 410, `usage ${r.status} ${r.text}`)
  })

  await test('GET /api/skills → 404（Skill 配置在 Gateway）', async () => {
    const r = await req(base, 'GET', '/api/skills', { token: SEAT_TOK })
    assert(r.status === 404 || r.status === 410, `skills ${r.status} ${r.text}`)
  })

  await test('GET /api/accounts → 404（账号管理在 Gateway）', async () => {
    const r = await req(base, 'GET', '/api/accounts', { token: SEAT_TOK })
    assert(r.status === 404 || r.status === 410, `accounts ${r.status} ${r.text}`)
  })

  await test('create+session 后 JSONL 首条是当前 version 且带 botId', async () => {
    const file = join(BOT_HOME, 'sessions', `${sessionId}.jsonl`)
    const first = readFileSync(file, 'utf8').split('\n').find((l) => l.trim())
    const ev = JSON.parse(first)
    assert(ev.type === 'session', '首条不是 session')
    assert(ev.data.version === SESSION_FORMAT, `version=${ev.data.version}，当前格式是 ${SESSION_FORMAT}`)
    assert(ev.data.botId === botId, 'botId')
  })

  await test('GET /internal/sessions/:id 席位凭证；错票 404 不暴露', async () => {
    const none = await req(base, 'GET', `/internal/sessions/${sessionId}`)
    assert(none.status === 404, `no token ${none.status} ${none.text}`)
    const bad = await req(base, 'GET', `/internal/sessions/${sessionId}`, { token: 'wrong-token' })
    assert(bad.status === 404, `bad token ${bad.status}`)
    const ok = await req(base, 'GET', `/internal/sessions/${sessionId}`, { token: SEAT_TOK })
    assert(ok.status === 200, `ok ${ok.status} ${ok.text}`)
    assert(Array.isArray(ok.json.events) && ok.json.events[0]?.type === 'session', 'events')
    const miss = await req(base, 'GET', '/internal/sessions/s-no-such', { token: SEAT_TOK })
    assert(miss.status === 404, `missing ${miss.status}`)
  })

  // 并发/原子性在 session-store 那组用探针直接压 SessionService，这里只管真进程里读得通。
  await test('旧格式会话经 /internal/sessions 读一次就地迁到当前版本', async () => {
    // v1 根事件：没有 botId / origin。读一次应就地迁到 v3。
    const legacyId = 's-legacy-v1'
    const file = join(BOT_HOME, 'sessions', `${legacyId}.jsonl`)
    const lines = [
      { seq: 1, time: 1, type: 'session', data: { version: 1, id: legacyId, createdAt: 1, title: '旧会话' } },
      {
        seq: 2,
        time: 2,
        type: 'user/message',
        data: { message: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'LEGACY-OK' }] }, source: { kind: 'user' } },
      },
    ]
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

    const a = await req(base, 'GET', `/internal/sessions/${legacyId}`, { token: SEAT_TOK })
    assert(a.status === 200, `legacy read ${a.status} ${a.text}`)
    assert(a.json.events.length === 2, `事件条数 ${a.json.events.length}`)

    const after = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert(after.length === 2, `迁移后行数 ${after.length}`)
    assert(after[0].data.version === SESSION_FORMAT, `迁移后 version ${after[0].data.version}，当前格式是 ${SESSION_FORMAT}`)
    assert(after[0].data.botId === 'default', `迁移后 botId ${after[0].data.botId}`)
    assert(after[0].data.origin === 'local', `迁移后 origin ${after[0].data.origin}`)
    assert(JSON.stringify(after[1]) === JSON.stringify(lines[1]), '正文事件被改动')
    const strays = readdirSync(join(BOT_HOME, 'sessions')).filter((f) => f.endsWith('.tmp'))
    assert(strays.length === 0, `留下临时文件 ${strays.join(',')}`)
  })

  await test('未登录 GET /api/runtime/status → 401', async () => {
    const r = await req(base, 'GET', '/api/runtime/status')
    assert(r.status === 401, `unauth status ${r.status} ${r.text}`)
  })

  await test('本机无 GATEWAY_URL 仍有 default bot', async () => {
    const r = await req(base, 'GET', '/api/bots', { token: SEAT_TOK })
    assert(r.status === 200, `bots ${r.status} ${r.text}`)
    assert((r.json.bots || []).some((b) => b.id === 'default'), '缺 default')
  })

  child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 400))
  try {
    child.kill('SIGKILL')
  } catch {}
}

