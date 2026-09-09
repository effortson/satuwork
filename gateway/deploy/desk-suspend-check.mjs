/**
 * 桌面预览「没人看就断开」的本地演练台。
 *
 * 起一个自己的 Gateway（自己的 schema、自己的端口，不碰 3080 和生产库），配一台假
 * 机器，部署一个 stub 席位，然后在假管家上供一个**会一直往下推字节**的 noVNC 冒牌
 * 落地页。
 *
 * 于是那件要验的事变成看得见的：
 *
 *   · 预览挂着 → 终端里的计数一直在涨
 *   · 把右栏滚到看不见它 / 切到别的标签页 → 五秒后打印「连接关闭」，计数停住
 *   · 滚回来 / 切回来 → 打印「连接打开」，计数继续
 *
 * 计数停不下来就是这次改动没生效——不用去猜 DOM 里那个 iframe 还在不在。
 *
 * 用法：
 *   docker compose up -d postgres
 *   node gateway/deploy/desk-suspend-check.mjs
 *
 * **已知缺口**：落地页里那条 WebSocket 在沙箱 iframe 里还没连通，所以「已推 KB」
 * 目前一直是 0；反代链路本身是好的（入口 302 → 落地页，Gateway 的样式与
 * localStorage 垫片都注入了）。在修好之前，判据用「连接 N」那一格和浏览器控制台：
 *
 *   ({ hidden: document.hidden, visibleNow: deskVisibleNow(),
 *      suspended: deskSuspended, mounted: deskMounted })
 *
 * 看不见满五秒之后 suspended 应变成 {full:false}、mounted 变 null；重新看得见时反过来。
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createServer as netServer } from 'node:net'
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// 相对自己算仓库根，不看 cwd——这个脚本从哪儿敲都该能跑。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GW_ROOT = join(ROOT, 'gateway')
const PG_URL = process.env.GATEWAY_DATABASE_URL || 'postgres://satuwork:satuwork@127.0.0.1:5434/satuwork'
const SCHEMA = 'dev_desk_suspend'
const GW_HOME = '/tmp/satuwork-desk-suspend'
const OWNER = { email: 'owner@desk.test', password: 'desk-owner-pass' }
const ADMIN = { email: 'admin@desk.test', password: 'desk-admin-pass' }

const freePort = () =>
  new Promise((ok) => {
    const s = netServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => ok(port))
    })
  })

// 形状对齐 e2e/run.mjs 的 req：publishRelease 要用 raw + headers。
async function req(base, method, path, { token, body, raw, headers: extra } = {}) {
  const headers = { ...(extra || {}) }
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const payload = raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body)
  const r = await fetch(base + path, { method, headers, body: payload })
  const text = await r.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: r.status, text, json }
}

const need = (r, what) => {
  if (r.status >= 400) throw new Error(`${what} 失败 ${r.status}：${r.text.slice(0, 300)}`)
  return r
}

/**
 * 假管家。只做两件事：供落地页、接 WebSocket 并往里灌字节。
 *
 * 落地页要有 `</head>`——Gateway 会往那儿插一段样式和 localStorage 垫片（见
 * gateway/src/desktop.ts），没有这个标签那一步会静默跳过，而那正好也是要顺带验的。
 */
function startFakeManager(port, tokenRef) {
  let live = 0
  let bytes = 0
  let lastPrinted = -1

  const PAGE = `<html><head><title>fake noVNC</title></head><body style="margin:0;background:#111;color:#0f0;font:13px monospace">
<div id="n" style="padding:8px">connecting…</div>
<script>
  var n = document.getElementById('n'), got = 0
  var ws = new WebSocket(new URL('websockify', location.href).href.replace(/^http/, 'ws'))
  ws.binaryType = 'arraybuffer'
  ws.onmessage = function (e) { got += e.data.byteLength || e.data.length || 0; n.textContent = 'recv ' + (got / 1024).toFixed(0) + ' KB' }
  ws.onopen = function () { n.textContent = 'open' }
  ws.onclose = function () { n.textContent = 'closed' }
<\/script>
</body></html>`

  const srv = createServer((rq, rs) => {
    // 探活不带机器票（配对回拨那一刻票还在 Gateway 手里），单独放行。
    if (rq.url.startsWith('/health')) {
      const challenge = new URL(rq.url, 'http://x').searchParams.get('challenge')
      return rs
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, challenge, managerVersion: '9.9.9', protocol: 2 }))
    }
    if (rq.headers['x-satuwork-machine'] !== tokenRef.value) return rs.writeHead(401).end('no machine token')
    rs.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
  })

  srv.on('upgrade', (rq, socket) => {
    if (rq.headers['x-satuwork-machine'] !== tokenRef.value) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n')
      return socket.destroy()
    }
    // 真握手要回 Sec-WebSocket-Accept，浏览器才认。
    const key = String(rq.headers['sec-websocket-key'] || '')
    const accept = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    live++
    console.log(`\n  ▲ 连接打开（当前 ${live} 条）`)

    // 每 200ms 推一个 8 KB 的二进制帧，模拟画面在动。够大到计数看得出来，
    // 又不至于把本机网卡跑满。
    const payload = Buffer.alloc(8192, 0x41)
    const timer = setInterval(() => {
      if (socket.destroyed) return
      const head = Buffer.from([0x82, 126, payload.length >> 8, payload.length & 0xff])
      socket.write(Buffer.concat([head, payload]))
      bytes += payload.length
    }, 200)

    const done = () => {
      clearInterval(timer)
      live--
      console.log(`\n  ▼ 连接关闭（当前 ${live} 条）`)
    }
    socket.on('close', done)
    socket.on('error', done)
  })

  setInterval(() => {
    const kb = Math.round(bytes / 1024)
    if (kb === lastPrinted) return
    lastPrinted = kb
    process.stdout.write(`\r  已推 ${String(kb).padStart(7)} KB   连接 ${live}   `)
  }, 500).unref()

  return new Promise((ok) => srv.listen(port, '127.0.0.1', () => ok(srv)))
}

// ── 起 Gateway ──────────────────────────────────────────────────────────
rmSync(GW_HOME, { recursive: true, force: true })
const GW_PORT = await freePort()
const MGR_PORT = await freePort()
const gwBase = `http://127.0.0.1:${GW_PORT}`

console.log(`# 起 Gateway（schema ${SCHEMA}，端口 ${GW_PORT}）`)
const gw = spawn(process.execPath, ['--import', 'tsx', join(GW_ROOT, 'src/index.ts')], {
  cwd: GW_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    SATUWORK_GATEWAY_HOME: GW_HOME,
    GATEWAY_DATABASE_URL: PG_URL,
    GATEWAY_PG_SCHEMA: SCHEMA,
    GATEWAY_PG_RESET: '1',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(GW_PORT),
    GATEWAY_MACHINE_TOKEN: 'desk-machine',
    GATEWAY_PLATFORM_TOKEN: 'desk-platform',
    GATEWAY_SEED_OWNER: '1',
    GATEWAY_OWNER_EMAIL: OWNER.email,
    GATEWAY_OWNER_PASSWORD: OWNER.password,
    SATUWORK_DEPLOY_STUB: '1',
  },
})
gw.stdout.on('data', (d) => process.env.DESK_VERBOSE && process.stdout.write(`[gw] ${d}`))
gw.stderr.on('data', (d) => process.stdout.write(`[gw] ${d}`))

for (let i = 0; ; i++) {
  try {
    if ((await fetch(gwBase + '/health')).ok) break
  } catch {}
  if (i > 150) throw new Error('Gateway 起不来')
  await new Promise((r) => setTimeout(r, 200))
}

try {
  // ── 公司 / 管理员 / Bot ───────────────────────────────────────────────
  const { createCompany } = await import(join(ROOT, 'e2e/org.mjs'))
  const org = await createCompany(req, gwBase, {
    ownerEmail: OWNER.email,
    ownerPassword: OWNER.password,
    email: ADMIN.email,
    password: ADMIN.password,
    companyName: '桌面演练',
    slug: 'desk-demo',
    seats: 2,
  })
  const adminTok = org.token
  const ownerTok = org.ownerToken
  const orgId = org.company.id

  // ── 配一台假机器 ──────────────────────────────────────────────────────
  // 先把假管家起起来：配对会回拨 /health，起晚了那一步就是 reachable:false。
  const tokenRef = { value: '' }
  await startFakeManager(MGR_PORT, tokenRef)
  console.log(`# 假管家在 127.0.0.1:${MGR_PORT}`)

  const code = need(await req(gwBase, 'POST', `/platform/orgs/${orgId}/pairing-code`, { token: ownerTok }), '配对码')
  const paired = need(
    await req(gwBase, 'POST', '/machines/pair', {
      // protocol 必须 ≥ MIN_DESKTOP_PROTOCOL（2），否则桌面那条会被顶回「管家版本过旧」。
      body: { code: code.json.code, managerPort: MGR_PORT, hostname: 'desk-demo', managerVersion: '9.9.9', protocol: 2 },
    }),
    '配对',
  )
  tokenRef.value = paired.json.token
  const machineId = paired.json.machineId

  /**
   * 心跳。**没有它桌面永远不 ready**——界面上是「机器 失联·从未心跳」，
   * 右栏那块停在「正在连接桌面…」，deskUrl() 返回空串，于是什么都不会挂。
   */
  const beat = async () => {
    await req(gwBase, 'POST', `/internal/machines/${machineId}/heartbeat`, {
      token: tokenRef.value,
      body: { managerVersion: '9.9.9', protocol: 2, node: process.versions.node, arch: process.arch },
    }).catch(() => {})
  }
  await beat()
  setInterval(beat, 10_000).unref()

  // ── 先发一个 Bot 版本：没有发布包就没法部署席位 ───────────────────────
  const { publishRelease } = await import(join(ROOT, 'e2e/release.mjs'))
  await publishRelease({ req, gwBase, token: 'desk-platform', version: '1.0.0-demo' })

  // ── 建 Bot 并部署一个 stub 席位 ───────────────────────────────────────
  const bot = need(
    await req(gwBase, 'POST', '/platform/bots', {
      token: ownerTok,
      body: { name: '演练 Bot' },
    }),
    '建 Bot',
  )
  const botId = bot.json.bot.id
  need(await req(gwBase, 'POST', '/runtime/deploy', { token: adminTok, body: { botId } }), '部署席位')

  const desk = await req(gwBase, `GET`, `/runtime/desktop?botId=${encodeURIComponent(botId)}`, { token: adminTok })
  if (desk.status !== 200 || !desk.json.novncUrl) {
    throw new Error(`拿不到桌面地址（${desk.status}）：${desk.text.slice(0, 300)}`)
  }

  console.log(`
────────────────────────────────────────────────────────────
  打开   ${gwBase}
  登录   ${ADMIN.email} / ${ADMIN.password}
  然后点进「演练 Bot」的对话页，右栏就是那块预览。

  验这三件事：
    1. 预览挂着时，下面的 KB 一直在涨
    2. 把右栏往下滚到看不见预览 → 五秒内应打印「连接关闭」，KB 停住
    3. 滚回来 → 应打印「连接打开」，KB 继续涨
    切到别的标签页 / 切回来，同样应该看到关闭与打开

  Ctrl-C 结束。
────────────────────────────────────────────────────────────
`)
  await new Promise(() => {})
} finally {
  process.on('exit', () => {
    try {
      gw.kill('SIGTERM')
    } catch {}
  })
}
